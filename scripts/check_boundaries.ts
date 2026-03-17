// Copyright 2025 the AAI authors. MIT license.
/**
 * Verify that cli/, server/, and ui/ do not import from each other.
 * Only sdk/ is allowed as a cross-package dependency.
 *
 * Catches both relative imports (../server/) and workspace imports (@aai/server).
 * Skips test files for workspace imports (test utils may share helpers).
 * Skips string literals (template code written to shim files).
 */

import * as log from "@std/log";
import { walk } from "@std/fs/walk";

const RULES: { dirs: string[]; forbidden: RegExp; skipTests: boolean }[] = [
  // No relative cross-imports between cli/, server/, and ui/
  {
    dirs: ["cli", "ui"],
    forbidden: /from\s+["']\.\.\/server\//,
    skipTests: false,
  },
  {
    dirs: ["server", "ui"],
    forbidden: /from\s+["']\.\.\/cli\//,
    skipTests: false,
  },
  { dirs: ["server"], forbidden: /from\s+["']\.\.\/ui\//, skipTests: false },
  // No workspace cross-imports (except in test files)
  {
    dirs: ["ui"],
    forbidden: /^import\b.*from\s+["']@aai\/server/,
    skipTests: true,
  },
  {
    dirs: ["server", "ui"],
    forbidden: /^import\b.*from\s+["']@aai\/cli/,
    skipTests: true,
  },
  {
    dirs: ["server"],
    forbidden: /^import\b.*from\s+["']@aai\/ui/,
    skipTests: true,
  },
];

let violations = 0;

for (const rule of RULES) {
  for (const dir of rule.dirs) {
    for await (
      const entry of walk(dir, {
        exts: [".ts", ".tsx"],
        includeDirs: false,
      })
    ) {
      if (
        rule.skipTests &&
        (entry.name.includes("_test") || entry.name.startsWith("_test"))
      ) continue;

      const content = await Deno.readTextFile(entry.path);
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (rule.forbidden.test(line)) {
          log.error(`${entry.path}:${i + 1}: ${line.trim()}`);
          violations++;
        }
      }
    }
  }
}

if (violations > 0) {
  log.error(`\nFound ${violations} import boundary violation(s).`);
  log.error("cli/, server/, and ui/ may only import from sdk/ and core/.");
  Deno.exit(1);
} else {
  log.info("Import boundaries OK");
}
