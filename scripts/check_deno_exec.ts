// Copyright 2025 the AAI authors. MIT license.
/**
 * Verify that cli/ code never passes Deno.execPath() directly to
 * Deno.Command. The compiled aai binary is not deno — use denoExec()
 * from _discover.ts instead, which falls back to "deno" on PATH.
 *
 * Allowed: Deno.execPath() in comparisons (e.g. isDevMode checks).
 * Forbidden: new Deno.Command(Deno.execPath(), ...) — breaks when compiled.
 */

import * as log from "@std/log";
import { walk } from "@std/fs/walk";

// Match Deno.Command(Deno.execPath()) — the actual bug pattern
const FORBIDDEN_REGEXP = /new\s+Deno\.Command\(\s*Deno\.execPath\(\)/;

let violations = 0;

for await (
  const entry of walk("cli", {
    exts: [".ts", ".tsx"],
    includeDirs: false,
  })
) {
  // Skip test files
  if (entry.name.includes("_test")) continue;

  const content = await Deno.readTextFile(entry.path);
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FORBIDDEN_REGEXP.test(line)) {
      log.error(
        `${entry.path}:${
          i + 1
        }: Deno.Command(Deno.execPath()) breaks when compiled — use denoExec()`,
      );
      log.error(`  ${line.trim()}`);
      violations++;
    }
  }
}

if (violations > 0) {
  log.error(
    `\nFound ${violations} Deno.execPath() misuse(s) in Deno.Command calls.`,
  );
  log.error("Use denoExec() from _discover.ts instead.");
  Deno.exit(1);
} else {
  log.info("Deno.execPath() usage OK");
}
