// Copyright 2025 the AAI authors. MIT license.
/**
 * Deno Worker factory with permission control.
 *
 * @module
 */

/**
 * Permission set with all permissions denied.
 *
 * Used for sandboxed agent workers and code-execution workers to ensure
 * agent code cannot access the network, filesystem, environment variables,
 * or any other system resources directly. Workers must use the
 * {@linkcode HostApi} proxy for any I/O.
 */
export const LOCKED_PERMISSIONS = {
  net: false,
  read: false,
  write: false,
  env: false,
  sys: false,
  run: false,
  ffi: false,
} as const;

/**
 * Create a Deno Worker with explicit permission options.
 *
 * Deno supports a `deno.permissions` option on the `Worker` constructor,
 * but TypeScript's built-in types don't include it. This function is the
 * single place where that cast happens, keeping the rest of the codebase
 * type-safe.
 *
 * @param specifier - The module URL or path for the worker script.
 * @param name - A human-readable name for the worker (shown in logs/debugger).
 * @param permissions - Deno permission flags for the worker sandbox.
 * @returns A new `Worker` instance with the specified permissions.
 *
 * @example
 * ```ts
 * const worker = createDenoWorker(
 *   new URL("./worker.ts", import.meta.url),
 *   "agent-worker",
 *   LOCKED_PERMISSIONS,
 * );
 * ```
 */
export function createDenoWorker(
  specifier: string | URL,
  name: string,
  permissions: {
    net: boolean;
    read: boolean;
    write: boolean;
    env: boolean;
    sys: boolean;
    run: boolean;
    ffi: boolean;
  },
): Worker {
  return new (Worker as unknown as new (
    specifier: string | URL,
    options: {
      type: "module";
      name: string;
      deno: { permissions: typeof permissions };
    },
  ) => Worker)(specifier, { type: "module", name, deno: { permissions } });
}
