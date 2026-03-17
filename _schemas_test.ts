// Copyright 2025 the AAI authors. MIT license.
import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  AgentConfigSchema,
  AgentMetadataSchema,
  ClientEventSchema,
  DeployBodySchema,
  EnvSchema,
  SessionErrorCodeSchema,
  ToolSchemaSchema,
} from "./_schemas.ts";

Deno.test("AgentConfigSchema", async (t) => {
  await t.step("accepts minimal config", () => {
    const result = AgentConfigSchema.safeParse({
      name: "Test",
      instructions: "Help",
      greeting: "Hi",
      voice: "",
    });
    assertStrictEquals(result.success, true);
  });

  await t.step("accepts full config", () => {
    const result = AgentConfigSchema.safeParse({
      name: "Agent",
      instructions: "Help",
      greeting: "Hi",
      voice: "",
      sttPrompt: "Transcribe accurately",
      maxSteps: 8,
      builtinTools: ["web_search", "run_code"],
      activeTools: ["web_search", "fetch_json"],
    });
    assertStrictEquals(result.success, true);
  });

  await t.step("rejects missing required fields", () => {
    assertStrictEquals(AgentConfigSchema.safeParse({}).success, false);
    assertStrictEquals(
      AgentConfigSchema.safeParse({ instructions: "x" }).success,
      false,
    );
  });
});

Deno.test("ToolSchemaSchema", async (t) => {
  await t.step("accepts valid tool schema", () => {
    const result = ToolSchemaSchema.safeParse({
      name: "greet",
      description: "Say hi",
      parameters: { type: "object" },
    });
    assertStrictEquals(result.success, true);
  });

  await t.step("rejects missing name", () => {
    const result = ToolSchemaSchema.safeParse({
      description: "Say hi",
      parameters: { type: "object" },
    });
    assertStrictEquals(result.success, false);
  });

  await t.step("rejects parameters without type: object", () => {
    const result = ToolSchemaSchema.safeParse({
      name: "greet",
      description: "Say hi",
      parameters: { type: "string" },
    });
    assertStrictEquals(result.success, false);
  });

  await t.step("accepts parameters with properties and required", () => {
    const result = ToolSchemaSchema.safeParse({
      name: "greet",
      description: "Say hi",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    });
    assertStrictEquals(result.success, true);
  });
});

const VALID_CONFIG = {
  name: "Test",
  instructions: "Help",
  greeting: "Hi",
  voice: "",
};

Deno.test("DeployBodySchema", async (t) => {
  await t.step("accepts valid deploy body", () => {
    const result = DeployBodySchema.safeParse({
      env: { ASSEMBLYAI_API_KEY: "test" },
      worker: "code",
      html: "<html></html>",
      config: VALID_CONFIG,
      toolSchemas: [],
    });
    assertStrictEquals(result.success, true);
  });

  await t.step("rejects empty worker", () => {
    const result = DeployBodySchema.safeParse({
      env: {},
      worker: "",
      html: "<html></html>",
      config: VALID_CONFIG,
      toolSchemas: [],
    });
    assertStrictEquals(result.success, false);
  });

  await t.step("accepts transport as array", () => {
    const result = DeployBodySchema.safeParse({
      env: {},
      worker: "code",
      html: "<html></html>",
      transport: ["websocket"],
      config: VALID_CONFIG,
      toolSchemas: [],
    });
    assertStrictEquals(result.success, true);
  });

  await t.step("rejects transport as bare string", () => {
    const result = DeployBodySchema.safeParse({
      env: {},
      worker: "code",
      html: "<html></html>",
      transport: "websocket",
      config: VALID_CONFIG,
      toolSchemas: [],
    });
    assertStrictEquals(result.success, false);
  });
});

Deno.test("EnvSchema", async (t) => {
  await t.step("accepts valid env", () => {
    const result = EnvSchema.safeParse({ ASSEMBLYAI_API_KEY: "key123" });
    assertStrictEquals(result.success, true);
  });

  await t.step("rejects empty ASSEMBLYAI_API_KEY", () => {
    const result = EnvSchema.safeParse({ ASSEMBLYAI_API_KEY: "" });
    assertStrictEquals(result.success, false);
  });

  await t.step("allows extra keys via passthrough", () => {
    const result = EnvSchema.safeParse({
      ASSEMBLYAI_API_KEY: "key",
      CUSTOM: "val",
    });
    assertStrictEquals(result.success, true);
  });
});

Deno.test("AgentMetadataSchema", async (t) => {
  await t.step("accepts minimal metadata", () => {
    const result = AgentMetadataSchema.safeParse({
      slug: "test",
      config: VALID_CONFIG,
      toolSchemas: [],
    });
    assertStrictEquals(result.success, true);
    if (result.success) {
      assertEquals(result.data.env, {});
      assertEquals(result.data.transport, ["websocket"]);
    }
  });

  await t.step("accepts full metadata", () => {
    const result = AgentMetadataSchema.safeParse({
      slug: "my-agent",
      env: { KEY: "val" },
      transport: ["websocket"],
      credential_hashes: ["abc123"],
      config: VALID_CONFIG,
      toolSchemas: [],
    });
    assertStrictEquals(result.success, true);
  });

  await t.step("rejects missing slug", () => {
    const result = AgentMetadataSchema.safeParse({ env: {} });
    assertStrictEquals(result.success, false);
  });
});

Deno.test("SessionErrorCodeSchema", async (t) => {
  await t.step("accepts all valid error codes", () => {
    for (
      const code of [
        "stt",
        "llm",
        "tts",
        "tool",
        "protocol",
        "connection",
        "audio",
        "internal",
      ]
    ) {
      assertStrictEquals(SessionErrorCodeSchema.safeParse(code).success, true);
    }
  });

  await t.step("rejects invalid error codes", () => {
    assertStrictEquals(
      SessionErrorCodeSchema.safeParse("unknown").success,
      false,
    );
    assertStrictEquals(SessionErrorCodeSchema.safeParse("").success, false);
    assertStrictEquals(SessionErrorCodeSchema.safeParse(42).success, false);
  });
});

Deno.test("ClientEventSchema", async (t) => {
  await t.step("accepts partial transcript", () => {
    const result = ClientEventSchema.safeParse({
      type: "transcript",
      text: "hello",
      isFinal: false,
    });
    assertStrictEquals(result.success, true);
  });

  await t.step("accepts final transcript with turnOrder", () => {
    const result = ClientEventSchema.safeParse({
      type: "transcript",
      text: "hello world",
      isFinal: true,
      turnOrder: 3,
    });
    assertStrictEquals(result.success, true);
  });

  await t.step("accepts final transcript without turnOrder", () => {
    const result = ClientEventSchema.safeParse({
      type: "transcript",
      text: "hello world",
      isFinal: true,
    });
    assertStrictEquals(result.success, true);
  });

  await t.step("accepts turn event", () => {
    assertStrictEquals(
      ClientEventSchema.safeParse({ type: "turn", text: "What?" }).success,
      true,
    );
  });

  await t.step("accepts chat event", () => {
    assertStrictEquals(
      ClientEventSchema.safeParse({ type: "chat", text: "Hi" }).success,
      true,
    );
  });

  await t.step("accepts tts_done event", () => {
    assertStrictEquals(
      ClientEventSchema.safeParse({ type: "tts_done" }).success,
      true,
    );
  });

  await t.step("accepts cancelled event", () => {
    assertStrictEquals(
      ClientEventSchema.safeParse({ type: "cancelled" }).success,
      true,
    );
  });

  await t.step("accepts reset event", () => {
    assertStrictEquals(
      ClientEventSchema.safeParse({ type: "reset" }).success,
      true,
    );
  });

  await t.step("accepts error event with valid code", () => {
    const result = ClientEventSchema.safeParse({
      type: "error",
      code: "stt",
      message: "Connection lost",
    });
    assertStrictEquals(result.success, true);
  });

  await t.step("rejects error event with invalid code", () => {
    const result = ClientEventSchema.safeParse({
      type: "error",
      code: "bogus",
      message: "bad",
    });
    assertStrictEquals(result.success, false);
  });

  await t.step("rejects error event without code", () => {
    const result = ClientEventSchema.safeParse({
      type: "error",
      message: "bad",
    });
    assertStrictEquals(result.success, false);
  });

  await t.step("rejects unknown event type", () => {
    assertStrictEquals(
      ClientEventSchema.safeParse({ type: "unknown" }).success,
      false,
    );
  });
});
