// Copyright 2025 the AAI authors. MIT license.
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { asMessagePort } from "@aai/sdk/capnweb-transport";

const output: string[] = [];
function capture(...args: unknown[]) {
  output.push(args.map(String).join(" "));
}

const fakeConsole = {
  log: capture,
  info: capture,
  warn: capture,
  error: capture,
  debug: capture,
};

/**
 * Cap'n Web RPC target for the sandboxed code execution worker.
 *
 * Exposes a single `execute` method that runs arbitrary JavaScript
 * in a locked-down Deno Worker with no permissions.
 */
class SandboxTarget extends RpcTarget {
  async execute(code: string): Promise<{ output: string; error?: string }> {
    output.length = 0;
    const AsyncFunction = Object.getPrototypeOf(async function () {})
      .constructor;
    const fn = new AsyncFunction("console", code);
    try {
      await fn(fakeConsole);
      return { output: output.join("\n") };
    } catch (err: unknown) {
      return {
        output: output.join("\n"),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

newMessagePortRpcSession(asMessagePort(self), new SandboxTarget());
