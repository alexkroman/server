// Copyright 2025 the AAI authors. MIT license.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import client from "prom-client";
import {
  _internals,
  registry,
  serialize,
  serializeForAgent,
} from "./metrics.ts";

const { createCounter, createGauge, createHistogram } = _internals;

Deno.test("counter without labels", async () => {
  const c = createCounter("test_total", { help: "A test counter" });
  assertStringIncludes(await c.serialize(), "test_total 0");
  c.inc();
  c.inc();
  assertStringIncludes(await c.serialize(), "test_total 2");
  c.inc(undefined, 5);
  assertStringIncludes(await c.serialize(), "test_total 7");
});

Deno.test("counter with labels", async () => {
  const c = createCounter("err_total", {
    help: "Errors",
    labelNames: ["component"],
  });
  c.inc({ component: "llm" });
  c.inc({ component: "stt" });
  c.inc({ component: "llm" });
  const output = await c.serialize();
  assertStringIncludes(output, "# HELP err_total Errors");
  assertStringIncludes(output, "# TYPE err_total counter");
  assertStringIncludes(output, 'err_total{component="llm"} 2');
  assertStringIncludes(output, 'err_total{component="stt"} 1');
});

Deno.test("counter with multiple labels", async () => {
  const c = createCounter("errs", {
    help: "Errors",
    labelNames: ["agent", "component"],
  });
  c.inc({ agent: "ns/bot", component: "llm" });
  c.inc({ agent: "ns/bot", component: "llm" });
  c.inc({ agent: "ns/bot", component: "stt" });
  const output = await c.serialize();
  assertStringIncludes(output, 'errs{agent="ns/bot",component="llm"} 2');
  assertStringIncludes(output, 'errs{agent="ns/bot",component="stt"} 1');
});

Deno.test("gauge without labels", async () => {
  const g = createGauge("active", { help: "Active items" });
  assertStringIncludes(await g.serialize(), "active 0");
  g.inc();
  g.inc();
  g.dec();
  assertStringIncludes(await g.serialize(), "active 1");
  assertStringIncludes(await g.serialize(), "# TYPE active gauge");
});

Deno.test("gauge with labels", async () => {
  const g = createGauge("sessions", {
    help: "Sessions",
    labelNames: ["agent"],
  });
  g.inc({ agent: "a/one" });
  g.inc({ agent: "a/two" });
  g.inc({ agent: "a/one" });
  g.dec({ agent: "a/one" });
  const output = await g.serialize();
  assertStringIncludes(output, 'sessions{agent="a/one"} 1');
  assertStringIncludes(output, 'sessions{agent="a/two"} 1');
});

Deno.test("histogram default buckets", async () => {
  const h = createHistogram("dur", { help: "Duration" });
  h.observe(0.03);
  h.observe(0.2);
  h.observe(3.0);
  const output = await h.serialize();
  assertStringIncludes(output, "# TYPE dur histogram");
  assertStringIncludes(output, 'le="0.05"} 1');
  assertStringIncludes(output, 'le="0.1"} 1');
  assertStringIncludes(output, 'le="0.25"} 2');
  assertStringIncludes(output, 'le="0.5"} 2');
  assertStringIncludes(output, 'le="5"} 3');
  assertStringIncludes(output, 'le="+Inf"} 3');
  assertStringIncludes(output, "dur_sum 3.23");
  assertStringIncludes(output, "dur_count 3");
});

Deno.test("histogram custom buckets", async () => {
  const h = createHistogram("stt", {
    help: "STT connect",
    buckets: [0.1, 0.5, 1, 5],
  });
  h.observe(0.05);
  h.observe(0.3);
  h.observe(3.0);
  const output = await h.serialize();
  assertStringIncludes(output, 'le="0.1"} 1');
  assertStringIncludes(output, 'le="0.5"} 2');
  assertStringIncludes(output, 'le="1"} 2');
  assertStringIncludes(output, 'le="5"} 3');
  assertStringIncludes(output, 'le="+Inf"} 3');
  assertStringIncludes(output, "stt_count 3");
});

Deno.test("histogram with labels", async () => {
  const h = createHistogram("turn_dur", {
    help: "Turn duration",
    buckets: [0.5, 1, 5],
    labelNames: ["agent"],
  });
  h.observe(0.3, { agent: "ns/bot" });
  h.observe(2.0, { agent: "ns/bot" });
  h.observe(0.1, { agent: "ns/other" });
  const output = await h.serialize();
  // prom-client puts le before user labels
  assertStringIncludes(output, 'le="0.5",agent="ns/bot"} 1');
  assertStringIncludes(output, 'le="5",agent="ns/bot"} 2');
  assertStringIncludes(output, 'le="+Inf",agent="ns/bot"} 2');
  assertStringIncludes(output, 'turn_dur_count{agent="ns/bot"} 2');
  assertStringIncludes(output, 'le="0.5",agent="ns/other"} 1');
  assertStringIncludes(output, 'turn_dur_count{agent="ns/other"} 1');
});

Deno.test("histogram with no observations", async () => {
  const h = createHistogram("empty", { help: "Empty", buckets: [1, 5] });
  const output = await h.serialize();
  assertStringIncludes(output, 'le="1"} 0');
  assertStringIncludes(output, 'le="5"} 0');
  assertStringIncludes(output, 'le="+Inf"} 0');
  assertStringIncludes(output, "empty_sum 0");
  assertStringIncludes(output, "empty_count 0");
});

Deno.test("serialize returns registry output", async () => {
  const counter = new client.Counter({
    name: "test_serialize_check",
    help: "Temporary test metric",
    registers: [registry],
  });
  counter.inc();
  try {
    const output = await serialize();
    assertStringIncludes(output, "test_serialize_check");
    assert(output.endsWith("\n"));
  } finally {
    registry.removeSingleMetric("test_serialize_check");
  }
});

// --- Per-agent filtering ---

Deno.test("counter filters by agent and strips agent label", async () => {
  const c = createCounter("errs_f", {
    help: "Errors",
    labelNames: ["agent", "component"],
  });
  c.inc({ agent: "ns/a", component: "llm" });
  c.inc({ agent: "ns/a", component: "llm" });
  c.inc({ agent: "ns/b", component: "stt" });
  c.inc({ agent: "ns/a", component: "turn" });
  const output = await c.serialize("ns/a");
  assertStringIncludes(output, 'errs_f{component="llm"} 2');
  assertStringIncludes(output, 'errs_f{component="turn"} 1');
  assert(!output.includes("ns/b"));
  assert(!output.includes("stt"));
  assert(!output.includes('agent="'));
});

Deno.test("counter with only agent label strips to bare metric", async () => {
  const c = createCounter("turns", { help: "Turns", labelNames: ["agent"] });
  c.inc({ agent: "ns/a" });
  c.inc({ agent: "ns/a" });
  c.inc({ agent: "ns/b" });
  const output = await c.serialize("ns/a");
  assertStringIncludes(output, "turns 2");
  assert(!output.includes("ns/b"));
  assert(!output.includes("{"));
});

Deno.test("gauge filters by agent", async () => {
  const g = createGauge("active_f", {
    help: "Active",
    labelNames: ["agent"],
  });
  g.inc({ agent: "ns/a" });
  g.inc({ agent: "ns/a" });
  g.inc({ agent: "ns/b" });
  g.dec({ agent: "ns/a" });
  const output = await g.serialize("ns/a");
  assertStringIncludes(output, "active_f 1");
  assert(!output.includes("ns/b"));
});

Deno.test("histogram filters by agent and strips label", async () => {
  const h = createHistogram("dur_f", {
    help: "Duration",
    buckets: [0.5, 1, 5],
    labelNames: ["agent"],
  });
  h.observe(0.3, { agent: "ns/a" });
  h.observe(2.0, { agent: "ns/a" });
  h.observe(0.1, { agent: "ns/b" });
  const output = await h.serialize("ns/a");
  assertStringIncludes(output, 'le="0.5"} 1');
  assertStringIncludes(output, 'le="5"} 2');
  assertStringIncludes(output, 'le="+Inf"} 2');
  assertStringIncludes(output, "dur_f_count 2");
  assert(!output.includes("ns/a"));
  assert(!output.includes("ns/b"));
  assert(!output.includes('agent="'));
});

Deno.test("histogram keeps non-agent labels when filtering", async () => {
  const h = createHistogram("tool_dur", {
    help: "Tool",
    buckets: [1, 5],
    labelNames: ["agent", "tool"],
  });
  h.observe(0.5, { agent: "ns/a", tool: "search" });
  h.observe(2.0, { agent: "ns/a", tool: "fetch" });
  h.observe(0.1, { agent: "ns/b", tool: "search" });
  const output = await h.serialize("ns/a");
  assertStringIncludes(output, 'le="1",tool="search"} 1');
  assertStringIncludes(output, 'le="5",tool="fetch"} 1');
  assertStringIncludes(output, 'tool_dur_count{tool="search"} 1');
  assertStringIncludes(output, 'tool_dur_count{tool="fetch"} 1');
  assert(!output.includes("ns/b"));
  assert(!output.includes('agent="'));
});

Deno.test("returns empty data for unknown agent", async () => {
  const c = createCounter("x", { help: "X", labelNames: ["agent"] });
  c.inc({ agent: "ns/a" });
  const output = await c.serialize("ns/unknown");
  assertStringIncludes(output, "# HELP");
  assert(!output.includes("ns/a"));
  const dataLines = output.split("\n").filter((l) =>
    !l.startsWith("#") && l.trim() !== ""
  );
  assertEquals(dataLines.length, 0);
});

Deno.test("serializeForAgent filters by agent on shared registry", async () => {
  const counter = new client.Counter({
    name: "test_agent_filter",
    help: "Agent filter test",
    labelNames: ["agent"],
    registers: [registry],
  });
  counter.inc({ agent: "test/yes" });
  counter.inc({ agent: "test/no" });
  try {
    const output = await serializeForAgent("test/yes");
    assertStringIncludes(output, "test_agent_filter 1");
    assert(!output.includes("test/no"));
  } finally {
    registry.removeSingleMetric("test_agent_filter");
  }
});

Deno.test("metric without agent label is excluded from agent filter", async () => {
  const c = createCounter("plain", { help: "Plain counter" });
  c.inc();
  c.inc();
  const agentView = await c.serialize("ns/a");
  assertStringIncludes(agentView, "# HELP plain Plain counter");
  assertStringIncludes(agentView, "# TYPE plain counter");
  const dataLines = agentView.split("\n").filter((l) =>
    !l.startsWith("#") && l.trim() !== ""
  );
  assertEquals(dataLines.length, 0);
  // Global view should still include the metric
  assertStringIncludes(await c.serialize(), "plain 2");
});
