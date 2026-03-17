// Copyright 2025 the AAI authors. MIT license.
import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { z } from "zod";
import { createWorkerApi } from "./_worker_entry.ts";
import type { HostApi } from "@aai/sdk/protocol";
import { executeToolCall, TOOL_HANDLER_TIMEOUT } from "@aai/sdk/worker-entry";
import type { ToolDef } from "@aai/sdk/types";
import { initWorker } from "@aai/sdk/worker-shim";

function makeTool(
  execute: ToolDef["execute"],
  params?: ToolDef["parameters"],
): ToolDef {
  return { description: "test tool", parameters: params, execute };
}

function dummyHostApi(): HostApi {
  return {
    fetch() {
      return Promise.resolve({
        status: 200,
        statusText: "OK",
        headers: {},
        body: "",
      });
    },
    kv() {
      return Promise.resolve({ result: null });
    },
    vectorSearch() {
      return Promise.resolve("[]");
    },
  };
}

function hostApi(overrides?: Partial<HostApi>): HostApi {
  return { ...dummyHostApi(), ...overrides };
}

function createPairedChannel() {
  // Use a real MessageChannel so capnweb's newMessagePortRpcSession works
  const channel = new MessageChannel();
  return { workerSide: channel.port1, hostSide: channel.port2 };
}

function setupWorker(
  agent: Parameters<typeof initWorker>[0],
  hostApiVal?: HostApi,
  env?: Record<string, string>,
) {
  const { workerSide, hostSide } = createPairedChannel();

  // Pass the port directly to initWorker instead of monkey-patching self
  initWorker(agent, workerSide);

  // Host side uses the other port — capnweb handles the RPC protocol
  const api = createWorkerApi(hostSide, hostApiVal, env);
  return { api };
}

Deno.test("executeToolCall", async (t) => {
  await t.step("calls execute and returns string result", async () => {
    const tool = makeTool(() => "hello");
    const result = await executeToolCall("greet", {}, { tool, env: {} });
    assertStrictEquals(result, "hello");
  });

  await t.step("returns JSON for non-string result", async () => {
    const tool = makeTool(() => ({ key: "value" }));
    const result = await executeToolCall("data", {}, { tool, env: {} });
    assertStrictEquals(result, '{"key":"value"}');
  });

  await t.step("returns 'null' for null result", async () => {
    const tool = makeTool(() => null);
    const result = await executeToolCall("noop", {}, { tool, env: {} });
    assertStrictEquals(result, "null");
  });

  await t.step("validates args against schema", async () => {
    const tool = makeTool(
      (args) => `Hello ${args.name}`,
      z.object({ name: z.string() }),
    );
    const result = await executeToolCall("greet", { name: 42 }, {
      tool,
      env: {},
    });
    assertStringIncludes(result, "Error: Invalid arguments");
    assertStringIncludes(result, "greet");
  });

  await t.step("passes valid args through schema", async () => {
    const tool = makeTool(
      (args) => `Hello ${args.name}`,
      z.object({ name: z.string() }),
    );
    const result = await executeToolCall("greet", { name: "world" }, {
      tool,
      env: {},
    });
    assertStrictEquals(result, "Hello world");
  });

  await t.step("catches execution errors", async () => {
    const tool = makeTool(() => {
      throw new Error("boom");
    });
    const result = await executeToolCall("fail", {}, { tool, env: {} });
    assertStrictEquals(result, "Error: boom");
  });

  await t.step("passes env and sessionId in context", async () => {
    let capturedCtx: unknown;
    const tool = makeTool((_args, ctx) => {
      capturedCtx = ctx;
      return "ok";
    });
    await executeToolCall("t", {}, {
      tool,
      env: { KEY: "val" },
      sessionId: "sess-1",
    });
    const ctx = capturedCtx as {
      env: Record<string, string>;
      sessionId: string;
    };
    assertEquals(ctx.env, { KEY: "val" });
    assertStrictEquals(ctx.sessionId, "sess-1");
  });

  await t.step("passes state in context", async () => {
    let capturedState: unknown;
    const tool = makeTool((_args, ctx) => {
      capturedState = ctx.state;
      return "ok";
    });
    const state = { count: 5 };
    await executeToolCall("t", {}, { tool, env: {}, state });
    assertEquals(capturedState, { count: 5 });
  });
});

Deno.test("TOOL_HANDLER_TIMEOUT", () => {
  assertStrictEquals(TOOL_HANDLER_TIMEOUT, 30_000);
});

Deno.test("postMessage RPC worker", async (t) => {
  await t.step("handles executeTool", async () => {
    const { api } = setupWorker({
      name: "Test",
      env: [],
      transport: ["websocket"],
      instructions: "",
      greeting: "",
      voice: "",
      maxSteps: 5,
      tools: {
        greet: {
          description: "Say hi",
          execute: () => "hello",
        },
      },
    });

    const result = await api.executeTool("greet", {}, "s1", 5000);
    assertStrictEquals(result, "hello");
    api.dispose?.();
  });

  await t.step("returns error for unknown tool", async () => {
    const { api } = setupWorker({
      name: "Test",
      env: [],
      transport: ["websocket"],
      instructions: "",
      greeting: "",
      voice: "",
      maxSteps: 5,
      tools: {},
    });

    const result = await api.executeTool("missing", {}, undefined, 5000);
    assertStringIncludes(result, 'Unknown tool "missing"');
    api.dispose?.();
  });

  await t.step("handles onConnect hook", async () => {
    let connected = false;
    const { api } = setupWorker({
      name: "Test",
      env: [],
      transport: ["websocket"],
      instructions: "",
      greeting: "",
      voice: "",
      maxSteps: 5,
      tools: {},
      onConnect: () => {
        connected = true;
      },
    });

    await api.onConnect("s1", 5000);
    assertStrictEquals(connected, true);
    api.dispose?.();
  });

  await t.step("initializes per-session state", async () => {
    let capturedState: unknown;
    const { api } = setupWorker(
      {
        name: "Test",
        env: [],
        transport: ["websocket"],
        instructions: "",
        greeting: "",
        voice: "",
        maxSteps: 5,
        tools: {
          check: {
            description: "check state",
            execute: (_args, ctx) => {
              capturedState = ctx.state;
              return "ok";
            },
          },
        },
        state: () => ({ count: 0 }),
      },
      dummyHostApi(),
    );

    await api.executeTool("check", {}, "s1", 5000);
    assertEquals(capturedState, { count: 0 });
    api.dispose?.();
  });

  await t.step("cleans up session state on onDisconnect", async () => {
    const states: unknown[] = [];
    const { api } = setupWorker(
      {
        name: "Test",
        env: [],
        transport: ["websocket"],
        instructions: "",
        greeting: "",
        voice: "",
        maxSteps: 5,
        tools: {
          check: {
            description: "check state",
            execute: (_args, ctx) => {
              states.push({ ...ctx.state as Record<string, unknown> });
              return "ok";
            },
          },
        },
        state: () => ({ count: 0 }),
        onDisconnect: () => {},
      },
      dummyHostApi(),
    );

    await api.executeTool("check", {}, "s1", 5000);
    await api.onDisconnect("s1", 5000);
    await api.executeTool("check", {}, "s1", 5000);
    assertEquals(states, [{ count: 0 }, { count: 0 }]);
    api.dispose?.();
  });

  await t.step("sends step object directly (no JSON stringify)", async () => {
    let capturedStep: unknown;
    const { api } = setupWorker(
      {
        name: "Test",
        env: [],
        transport: ["websocket"],
        instructions: "",
        greeting: "",
        voice: "",
        maxSteps: 5,
        tools: {},
        onStep: (step) => {
          capturedStep = step;
        },
      },
      dummyHostApi(),
    );

    const step = {
      stepNumber: 1,
      toolCalls: [{ toolName: "greet", args: {} }],
      text: "hello",
    };
    await api.onStep("s1", step, 5000);
    assertEquals(capturedStep, step);
    api.dispose?.();
  });
});

Deno.test("fetch proxy via postMessage RPC", async (t) => {
  await t.step("worker fetch proxies through host", async () => {
    let capturedFetch: typeof globalThis.fetch | undefined;
    const { api } = setupWorker(
      {
        name: "Test",
        env: [],
        transport: ["websocket"],
        instructions: "",
        greeting: "",
        voice: "",
        maxSteps: 5,
        tools: {
          do_fetch: {
            description: "fetch something",
            execute: async () => {
              capturedFetch = globalThis.fetch;
              const resp = await globalThis.fetch(
                "https://api.example.com/data",
              );
              return await resp.text();
            },
          },
        },
      },
      hostApi({
        fetch(req) {
          return Promise.resolve({
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            body: `{"proxied":"${req.url}"}`,
          });
        },
      }),
    );

    const result = await api.executeTool("do_fetch", {}, "s1", 5000);
    assertStrictEquals(result, '{"proxied":"https://api.example.com/data"}');
    assertNotStrictEquals(capturedFetch, undefined);
    api.dispose?.();
  });

  await t.step("fetch proxy returns proper Response object", async () => {
    let capturedStatus: number | undefined;
    let capturedHeaders: string | undefined;

    const { api } = setupWorker(
      {
        name: "Test",
        env: [],
        transport: ["websocket"],
        instructions: "",
        greeting: "",
        voice: "",
        maxSteps: 5,
        tools: {
          check_response: {
            description: "check response properties",
            execute: async () => {
              const resp = await globalThis.fetch("https://example.com");
              capturedStatus = resp.status;
              capturedHeaders = resp.headers.get("x-custom") ?? undefined;
              return `${resp.status} ${resp.statusText}`;
            },
          },
        },
      },
      hostApi({
        fetch() {
          return Promise.resolve({
            status: 201,
            statusText: "Created",
            headers: { "x-custom": "test-value" },
            body: "",
          });
        },
      }),
    );

    const result = await api.executeTool("check_response", {}, "s1", 5000);
    assertStrictEquals(result, "201 Created");
    assertStrictEquals(capturedStatus, 201);
    assertStrictEquals(capturedHeaders, "test-value");
    api.dispose?.();
  });

  await t.step("fetch proxy propagates host errors", async () => {
    const { api } = setupWorker(
      {
        name: "Test",
        env: [],
        transport: ["websocket"],
        instructions: "",
        greeting: "",
        voice: "",
        maxSteps: 5,
        tools: {
          bad_fetch: {
            description: "fetch blocked URL",
            execute: async () => {
              await globalThis.fetch("http://169.254.169.254/metadata");
              return "should not reach";
            },
          },
        },
      },
      hostApi({
        fetch() {
          return Promise.reject(
            new Error("Blocked request to private address: 169.254.169.254"),
          );
        },
      }),
    );

    const result = await api.executeTool("bad_fetch", {}, "s1", 5000);
    assertStringIncludes(result, "Blocked request to private address");
    api.dispose?.();
  });

  await t.step("fetch proxy sends method and headers", async () => {
    let capturedMethod: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: string | null | undefined;

    const { api } = setupWorker(
      {
        name: "Test",
        env: [],
        transport: ["websocket"],
        instructions: "",
        greeting: "",
        voice: "",
        maxSteps: 5,
        tools: {
          post_data: {
            description: "POST some data",
            execute: async () => {
              const resp = await globalThis.fetch("https://api.example.com", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: '{"hello":"world"}',
              });
              return await resp.text();
            },
          },
        },
      },
      hostApi({
        fetch(req) {
          capturedMethod = req.method;
          capturedHeaders = req.headers;
          capturedBody = req.body;
          return Promise.resolve({
            status: 200,
            statusText: "OK",
            headers: {},
            body: "posted",
          });
        },
      }),
    );

    const result = await api.executeTool("post_data", {}, "s1", 5000);
    assertStrictEquals(result, "posted");
    assertStrictEquals(capturedMethod, "POST");
    assertStrictEquals(capturedHeaders?.["content-type"], "application/json");
    assertStrictEquals(capturedBody, '{"hello":"world"}');
    api.dispose?.();
  });
});

Deno.test("createWorkerApi with hostApi", async (t) => {
  await t.step(
    "creates bidirectional communication when hostApi provided",
    async () => {
      let fetchCalled = false;
      const { api } = setupWorker(
        {
          name: "Test",
          env: [],
          transport: ["websocket"],
          instructions: "",
          greeting: "",
          voice: "",
          maxSteps: 5,
          tools: {
            do_fetch: {
              description: "fetch",
              execute: async () => {
                const resp = await globalThis.fetch("https://example.com");
                return await resp.text();
              },
            },
          },
        },
        hostApi({
          fetch() {
            fetchCalled = true;
            return Promise.resolve({
              status: 200,
              statusText: "OK",
              headers: {},
              body: "ok",
            });
          },
        }),
      );

      await api.executeTool("do_fetch", {}, "s1", 5000);
      assertStrictEquals(fetchCalled, true);
      api.dispose?.();
    },
  );

  await t.step(
    "works without hostApi for tools that don't need fetch/kv",
    async () => {
      const { api } = setupWorker({
        name: "Test",
        env: [],
        transport: ["websocket"],
        instructions: "",
        greeting: "",
        voice: "",
        maxSteps: 5,
        tools: {
          greet: {
            description: "greet",
            execute: () => "hello",
          },
        },
      });

      const result = await api.executeTool("greet", {}, "s1", 5000);
      assertStrictEquals(result, "hello");
      api.dispose?.();
    },
  );

  await t.step("withEnv sets env once at creation", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const { api } = setupWorker(
      {
        name: "Test",
        env: [],
        transport: ["websocket"],
        instructions: "",
        greeting: "",
        voice: "",
        maxSteps: 5,
        tools: {
          check_env: {
            description: "check env",
            execute: (_args, ctx) => {
              capturedEnv = ctx.env;
              return "ok";
            },
          },
        },
      },
      dummyHostApi(),
      { KEY: "val" },
    );

    await api.executeTool("check_env", {}, "s1", 5000);
    assertStrictEquals(capturedEnv?.KEY, "val");
    api.dispose?.();
  });
});
