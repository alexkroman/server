#!/usr/bin/env -S deno run --allow-all
// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests every template by:
 * 1. Starting a local dev server
 * 2. Scaffolding each template into a temp directory
 * 3. Deploying each template to the local server
 * 4. Hitting each template's health check endpoint
 *
 * This script shells out to the CLI binary — it never imports internal
 * modules, so it can't accidentally be bundled into the compiled CLI.
 */

import * as log from "@std/log";
import { bold, brightMagenta, red } from "@std/fmt/colors";
import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");
const CLI = join(ROOT, "cli", "cli.ts");
const SERVER = join(ROOT, "server", "main.ts");
const TEMPLATES_DIR = join(ROOT, "templates");
const DENO = Deno.execPath();
const DENO_RUN = [
  DENO,
  "run",
  "--allow-all",
  "--unstable-worker-options",
  CLI,
];
const PORT = 3199; // Use a non-default port to avoid conflicts
const BASE_URL = `http://localhost:${PORT}`;

// Timeout: 5 min for warm-up (first build downloads JSR/npm), 3 min per template after
const WARMUP_TIMEOUT_MS = 300_000;
const STEP_TIMEOUT_MS = 180_000;

// Ensure ASSEMBLYAI_API_KEY is set
if (!Deno.env.get("ASSEMBLYAI_API_KEY")) {
  Deno.env.set("ASSEMBLYAI_API_KEY", "test");
}

// Discover templates
const templates: string[] = [];
for await (const entry of Deno.readDir(TEMPLATES_DIR)) {
  if (entry.isDirectory && !entry.name.startsWith("_")) {
    templates.push(entry.name);
  }
}
templates.sort();

log.info(`Testing ${templates.length} templates...\n`);

// --- Start local server ---
log.info("Starting local dev server...");
const serverProcess = new Deno.Command(DENO, {
  args: ["run", "--allow-all", "--unstable-worker-options", SERVER],
  env: { ...Deno.env.toObject(), PORT: String(PORT) },
  stdout: "piped",
  stderr: "piped",
}).spawn();

const maxWait = 15_000;
const start = Date.now();
let serverReady = false;
while (Date.now() - start < maxWait) {
  try {
    const resp = await fetch(`${BASE_URL}/health`);
    if (resp.ok) {
      serverReady = true;
      break;
    }
  } catch {
    // Server not ready yet
  }
  await new Promise((r) => setTimeout(r, 200));
}

if (!serverReady) {
  log.error("Server failed to start within 15s");
  serverProcess.kill("SIGTERM");
  Deno.exit(1);
}
log.info(`Server ready on port ${PORT}\n`);

/** Run a command with a timeout. Kills the process on timeout. */
async function run(
  args: string[],
  cwd: string,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<{ success: boolean; stderr: string }> {
  const child = new Deno.Command(args[0]!, {
    args: args.slice(1),
    cwd,
    env: { ...Deno.env.toObject(), INIT_CWD: cwd },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const timer = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited
    }
  }, timeoutMs);

  try {
    const result = await child.output();
    clearTimeout(timer);
    return {
      success: result.success,
      stderr: new TextDecoder().decode(result.stderr),
    };
  } catch {
    clearTimeout(timer);
    return { success: false, stderr: `Timed out after ${timeoutMs / 1000}s` };
  }
}

// --- Warm up: scaffold + deploy "simple" to populate all caches ---
// First build downloads JSR packages, compiles esbuild, resolves npm deps.
// Subsequent builds reuse the Deno module cache and are much faster.
log.info("Warming up caches (first scaffold + deploy)...");
const warmupDir = await Deno.makeTempDir({ prefix: "aai-test-warmup-" });
{
  const scaffold = await run(
    [...DENO_RUN, "new", "-t", "simple", "-y", "--force"],
    warmupDir,
    WARMUP_TIMEOUT_MS,
  );
  if (!scaffold.success) {
    log.error(`Warmup scaffold failed: ${scaffold.stderr.slice(0, 500)}`);
    serverProcess.kill("SIGTERM");
    Deno.exit(1);
  }
  const deploy = await run(
    [...DENO_RUN, "deploy", "-y", "-s", BASE_URL],
    warmupDir,
    WARMUP_TIMEOUT_MS,
  );
  if (!deploy.success) {
    log.error(`Warmup deploy failed: ${deploy.stderr.slice(0, 500)}`);
    serverProcess.kill("SIGTERM");
    Deno.exit(1);
  }
}
const sharedNodeModules = join(warmupDir, "node_modules");
log.info("Caches warm.\n");

// --- Scaffold, deploy, and health-check each template ---
const results: { name: string; ok: boolean; slug?: string; error?: string }[] =
  [];

for (const template of templates) {
  const tmpDir = await Deno.makeTempDir({ prefix: `aai-test-${template}-` });

  try {
    // Symlink shared node_modules BEFORE scaffold so ensureDependencies skips
    await Deno.symlink(sharedNodeModules, join(tmpDir, "node_modules"));

    // Scaffold
    log.info(`  ${template}: scaffolding...`);
    const scaffold = await run(
      [...DENO_RUN, "new", "-t", template, "-y", "--force"],
      tmpDir,
    );
    if (!scaffold.success) {
      throw new Error(`Scaffold failed: ${scaffold.stderr}`);
    }

    // Deploy to local server
    log.info(`  ${template}: deploying...`);
    const deploy = await run(
      [...DENO_RUN, "deploy", "-y", "-s", BASE_URL],
      tmpDir,
    );
    if (!deploy.success) {
      throw new Error(`Deploy failed: ${deploy.stderr}`);
    }

    // Extract slug from .aai/project.json
    const projectJson = JSON.parse(
      await Deno.readTextFile(join(tmpDir, ".aai", "project.json")),
    );
    const slug = projectJson.slug as string;

    // Health check
    const healthResp = await fetch(`${BASE_URL}/${slug}/health`);
    if (!healthResp.ok) {
      throw new Error(`Health check returned ${healthResp.status}`);
    }
    const health = await healthResp.json();
    if (health.status !== "ok") {
      throw new Error(`Health check status: ${JSON.stringify(health)}`);
    }

    log.info(`  ${brightMagenta("✓")} ${template} (${slug})`);
    results.push({ name: template, ok: true, slug });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`  ${red("✗")} ${template}`);
    log.info(`    ${msg.slice(0, 500)}`);
    results.push({ name: template, ok: false, error: msg });
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// --- Cleanup ---
serverProcess.kill("SIGTERM");
try {
  await serverProcess.status;
} catch {
  // Expected — process terminated
}
await Deno.remove(warmupDir, { recursive: true }).catch(() => {});

// --- Summary ---
log.info("");
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;

if (failed === 0) {
  log.info(bold(brightMagenta(`All ${passed} templates passed.`)));
} else {
  log.info(bold(red(`${failed} of ${results.length} templates failed:`)));
  for (const r of results.filter((r) => !r.ok)) {
    log.info(`  ${red("✗")} ${r.name}: ${r.error?.slice(0, 200)}`);
  }
  Deno.exit(1);
}
