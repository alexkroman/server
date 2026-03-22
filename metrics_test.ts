// Copyright 2025 the AAI authors. MIT license.
import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { _internals, serialize, serializeForAgent } from "./metrics.ts";

const { createCounter, createGauge, createHistogram } = _internals;

Deno.test("counter without labels", () => {
  const c = createCounter("test_total", { help: "A test counter" });
  assertStringIncludes(c.serialize(), "test_total 0");
  c.inc();
  c.inc();
  assertStringIncludes(c.serialize(), "test_total 2");
  c.inc(undefined, 5);
  assertStringIncludes(c.serialize(), "test_total 7");
});

Deno.test("counter with labels", () => {
  const c = createCounter("err_total", {
    help: "Errors",
    labelNames: ["component"],
  });
  c.inc({ component: "llm" });
  c.inc({ component: "stt" });
  c.inc({ component: "llm" });
  const output = c.serialize();
  assertStringIncludes(output, "# HELP err_total Errors");
  assertStringIncludes(output, "# TYPE err_total counter");
  assertStringIncludes(output, 'err_total{component="llm"} 2');
  assertStringIncludes(output, 'err_total{component="stt"} 1');
});

Deno.test("counter with multiple labels", () => {
  const c = createCounter("errs", {
    help: "Errors",
    labelNames: ["agent", "component"],
  });
  c.inc({ agent: "ns/bot", component: "llm" });
  c.inc({ agent: "ns/bot", component: "llm" });
  c.inc({ agent: "ns/bot", component: "stt" });
  const output = c.serialize();
  assertStringIncludes(output, 'errs{agent="ns/bot",component="llm"} 2');
  assertStringIncludes(output, 'errs{agent="ns/bot",component="stt"} 1');
});

Deno.test("gauge without labels", () => {
  const g = createGauge("active", { help: "Active items" });
  assertStringIncludes(g.serialize(), "active 0");
  g.inc();
  g.inc();
  g.dec();
  assertStringIncludes(g.serialize(), "active 1");
  assertStringIncludes(g.serialize(), "# TYPE active gauge");
});

Deno.test("gauge with labels", () => {
  const g = createGauge("sessions", {
    help: "Sessions",
    labelNames: ["agent"],
  });
  g.inc({ agent: "a/one" });
  g.inc({ agent: "a/two" });
  g.inc({ agent: "a/one" });
  g.dec({ agent: "a/one" });
  const output = g.serialize();
  assertStringIncludes(output, 'sessions{agent="a/one"} 1');
  assertStringIncludes(output, 'sessions{agent="a/two"} 1');
});

Deno.test("histogram default buckets", () => {
  const h = createHistogram("dur", { help: "Duration" });
  h.observe(0.03);
  h.observe(0.2);
  h.observe(3.0);
  const output = h.serialize();
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

Deno.test("histogram custom buckets", () => {
  const h = createHistogram("stt", {
    help: "STT connect",
    buckets: [0.1, 0.5, 1, 5],
  });
  h.observe(0.05);
  h.observe(0.3);
  h.observe(3.0);
  const output = h.serialize();
  assertStringIncludes(output, 'le="0.1"} 1');
  assertStringIncludes(output, 'le="0.5"} 2');
  assertStringIncludes(output, 'le="1"} 2');
  assertStringIncludes(output, 'le="5"} 3');
  assertStringIncludes(output, 'le="+Inf"} 3');
  assertStringIncludes(output, "stt_count 3");
});

Deno.test("histogram with labels", () => {
  const h = createHistogram("turn_dur", {
    help: "Turn duration",
    buckets: [0.5, 1, 5],
    labelNames: [
      "agent",
    ],
  });
  h.observe(0.3, { agent: "ns/bot" });
  h.observe(2.0, { agent: "ns/bot" });
  h.observe(0.1, { agent: "ns/other" });
  const output = h.serialize();
  assertStringIncludes(output, 'le="0.5",agent="ns/bot"} 1');
  assertStringIncludes(output, 'le="5",agent="ns/bot"} 2');
  assertStringIncludes(output, 'le="+Inf",agent="ns/bot"} 2');
  assertStringIncludes(output, 'turn_dur_count{agent="ns/bot"} 2');
  assertStringIncludes(output, 'le="0.5",agent="ns/other"} 1');
  assertStringIncludes(output, 'turn_dur_count{agent="ns/other"} 1');
});

Deno.test("histogram with no observations", () => {
  const h = createHistogram("empty", { help: "Empty", buckets: [1, 5] });
  const output = h.serialize();
  assertStringIncludes(output, 'le="1"} 0');
  assertStringIncludes(output, 'le="5"} 0');
  assertStringIncludes(output, 'le="+Inf"} 0');
  assertStringIncludes(output, "empty_sum 0");
  assertStringIncludes(output, "empty_count 0");
});

Deno.test("serialize includes all registered metrics", () => {
  const output = serialize();
  assertStringIncludes(output, "http_requests_total");
  assertStringIncludes(output, "http_request_duration_seconds");
  assert(output.endsWith("\n"));
});

// --- Per-agent filtering ---

Deno.test("counter filters by agent and strips agent label", () => {
  const c = createCounter("errs", {
    help: "Errors",
    labelNames: ["agent", "component"],
  });
  c.inc({ agent: "ns/a", component: "llm" });
  c.inc({ agent: "ns/a", component: "llm" });
  c.inc({ agent: "ns/b", component: "stt" });
  c.inc({ agent: "ns/a", component: "turn" });
  const output = c.serialize("ns/a");
  assertStringIncludes(output, 'errs{component="llm"} 2');
  assertStringIncludes(output, 'errs{component="turn"} 1');
  assert(!output.includes("ns/b"));
  assert(!output.includes("stt"));
  assert(!output.includes('agent="'));
});

Deno.test("counter with only agent label strips to bare metric", () => {
  const c = createCounter("turns", { help: "Turns", labelNames: ["agent"] });
  c.inc({ agent: "ns/a" });
  c.inc({ agent: "ns/a" });
  c.inc({ agent: "ns/b" });
  const output = c.serialize("ns/a");
  assertStringIncludes(output, "turns 2");
  assert(!output.includes("ns/b"));
  assert(!output.includes("{"));
});

Deno.test("gauge filters by agent", () => {
  const g = createGauge("active", { help: "Active", labelNames: ["agent"] });
  g.inc({ agent: "ns/a" });
  g.inc({ agent: "ns/a" });
  g.inc({ agent: "ns/b" });
  g.dec({ agent: "ns/a" });
  const output = g.serialize("ns/a");
  assertStringIncludes(output, "active 1");
  assert(!output.includes("ns/b"));
});

Deno.test("histogram filters by agent and strips label", () => {
  const h = createHistogram("dur", {
    help: "Duration",
    buckets: [0.5, 1, 5],
    labelNames: ["agent"],
  });
  h.observe(0.3, { agent: "ns/a" });
  h.observe(2.0, { agent: "ns/a" });
  h.observe(0.1, { agent: "ns/b" });
  const output = h.serialize("ns/a");
  assertStringIncludes(output, 'le="0.5"} 1');
  assertStringIncludes(output, 'le="5"} 2');
  assertStringIncludes(output, 'le="+Inf"} 2');
  assertStringIncludes(output, "dur_count 2");
  assert(!output.includes("ns/a"));
  assert(!output.includes("ns/b"));
  assert(!output.includes('agent="'));
});

Deno.test("histogram keeps non-agent labels when filtering", () => {
  const h = createHistogram("tool_dur", {
    help: "Tool",
    buckets: [1, 5],
    labelNames: ["agent", "tool"],
  });
  h.observe(0.5, { agent: "ns/a", tool: "search" });
  h.observe(2.0, { agent: "ns/a", tool: "fetch" });
  h.observe(0.1, { agent: "ns/b", tool: "search" });
  const output = h.serialize("ns/a");
  assertStringIncludes(output, 'le="1",tool="search"} 1');
  assertStringIncludes(output, 'le="5",tool="fetch"} 1');
  assertStringIncludes(output, 'tool_dur_count{tool="search"} 1');
  assertStringIncludes(output, 'tool_dur_count{tool="fetch"} 1');
  assert(!output.includes("ns/b"));
  assert(!output.includes('agent="'));
});

Deno.test("returns empty data for unknown agent", () => {
  const c = createCounter("x", { help: "X", labelNames: ["agent"] });
  c.inc({ agent: "ns/a" });
  const output = c.serialize("ns/unknown");
  assertStringIncludes(output, "# HELP");
  assert(!output.includes("ns/a"));
  const dataLines = output.split("\n").filter((l) =>
    !l.startsWith("#") && l.trim() !== ""
  );
  assertStrictEquals(dataLines.length, 0);
});

Deno.test("serializeForAgent includes agent metrics, excludes global", () => {
  const output = serializeForAgent("test/nonexistent");
  assertStringIncludes(output, "http_requests_total");
  assertStringIncludes(output, "http_request_duration_seconds");
});

Deno.test("metric without agent label is excluded from agent filter", () => {
  const c = createCounter("plain", { help: "Plain counter" });
  c.inc();
  c.inc();
  // Per-agent view should not include metrics that lack an "agent" label
  const agentView = c.serialize("ns/a");
  assertEquals(agentView, "# HELP plain Plain counter\n# TYPE plain counter");
  // Global view should still include the metric
  assertStringIncludes(c.serialize(), "plain 2");
});
