// Copyright 2025 the AAI authors. MIT license.
/**
 * Prometheus metrics backed by prom-client.
 *
 * Platform view:  GET /metrics          → serialize()
 * Customer view:  GET /:ns/:slug/metrics → serializeForAgent("ns/slug")
 */
import client from "prom-client";

type Labels = Record<string, string>;

/** Shared registry — passed to @hono/prometheus and used for serialization. */
export const registry = new client.Registry();

/** Serialize all metrics on the shared registry. */
export async function serialize(): Promise<string> {
  return registry.metrics();
}

/** Serialize metrics filtered to a specific agent, stripping the agent label. */
export async function serializeForAgent(agent: string): Promise<string> {
  const metrics = await registry.getMetricsAsJSON();
  return metrics.map((m) => formatForAgent(m, agent)).join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Per-agent filtering
// ---------------------------------------------------------------------------

function leString(val: unknown): string {
  if (val === Infinity || val === "Infinity") return "+Inf";
  return String(val);
}

function formatLabels(
  labels: Record<string, unknown>,
  skip?: string,
): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(labels)) {
    if (k === skip) continue;
    parts.push(`${k}="${k === "le" ? leString(v) : String(v)}"`);
  }
  return parts.length ? `{${parts.join(",")}}` : "";
}

function formatForAgent(
  metric: { name: string; help: string; type: string | client.MetricType; values: any[] },
  agent: string,
): string {
  const lines = [
    `# HELP ${metric.name} ${metric.help}`,
    `# TYPE ${metric.name} ${metric.type}`,
  ];
  if (!metric.values.some((v: any) => "agent" in v.labels)) {
    return lines.join("\n");
  }

  for (const v of metric.values) {
    if (v.labels.agent !== agent) continue;
    const suffix = formatLabels(v.labels, "agent");
    lines.push(`${v.metricName ?? metric.name}${suffix} ${v.value}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Factory helpers exposed for unit tests
// ---------------------------------------------------------------------------

type CounterLike = {
  inc(labels?: Labels, n?: number): void;
  serialize(agent?: string): Promise<string>;
};

type GaugeLike = {
  inc(labels?: Labels): void;
  dec(labels?: Labels): void;
  serialize(agent?: string): Promise<string>;
};

type HistogramLike = {
  observe(value: number, labels?: Labels): void;
  serialize(agent?: string): Promise<string>;
};

const DEFAULT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

async function serializeSingle(
  reg: client.Registry,
  name: string,
  agent?: string,
): Promise<string> {
  if (!agent) return reg.getSingleMetricAsString(name);
  const json = await reg.getMetricsAsJSON();
  const m = json.find((x) => x.name === name);
  return m ? formatForAgent(m, agent) : "";
}

function createCounter(
  name: string,
  opts: { help: string; labelNames?: string[] },
): CounterLike {
  const reg = new client.Registry();
  const counter = new client.Counter({
    name,
    help: opts.help,
    labelNames: opts.labelNames ?? [],
    registers: [reg],
  });
  return {
    inc(labels?: Labels, n = 1) {
      counter.inc(labels ?? {}, n);
    },
    serialize: (agent?: string) => serializeSingle(reg, name, agent),
  };
}

function createGauge(
  name: string,
  opts: { help: string; labelNames?: string[] },
): GaugeLike {
  const reg = new client.Registry();
  const gauge = new client.Gauge({
    name,
    help: opts.help,
    labelNames: opts.labelNames ?? [],
    registers: [reg],
  });
  return {
    inc(labels?: Labels) {
      gauge.inc(labels ?? {});
    },
    dec(labels?: Labels) {
      gauge.dec(labels ?? {});
    },
    serialize: (agent?: string) => serializeSingle(reg, name, agent),
  };
}

function createHistogram(
  name: string,
  opts: { help: string; buckets?: number[]; labelNames?: string[] },
): HistogramLike {
  const reg = new client.Registry();
  const histogram = new client.Histogram({
    name,
    help: opts.help,
    buckets: opts.buckets ?? DEFAULT_BUCKETS,
    labelNames: opts.labelNames ?? [],
    registers: [reg],
  });
  return {
    observe(value: number, labels?: Labels) {
      histogram.observe(labels ?? {}, value);
    },
    serialize: (agent?: string) => serializeSingle(reg, name, agent),
  };
}

/** @internal Exposed for unit tests only. */
export const _internals = { createCounter, createGauge, createHistogram };
