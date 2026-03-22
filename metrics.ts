// Copyright 2025 the AAI authors. MIT license.
/**
 * Lightweight Prometheus metrics. No external dependencies.
 *
 * Platform view:  GET /metrics          → serialize()
 * Customer view:  GET /:ns/:slug/metrics → serializeForAgent("ns/slug")
 */

const DEFAULT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

// OpenTelemetry recommended buckets for HTTP request duration
const HTTP_BUCKETS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.075,
  0.1,
  0.25,
  0.5,
  0.75,
  1,
  2.5,
  5,
  7.5,
  10,
];

type Labels = Record<string, string>;

function toKey(names: string[], labels?: Labels): string {
  if (!labels || names.length === 0) return "";
  return names.map((n) => `${n}="${labels[n] ?? ""}"`).join(",");
}

/** Filter + format a single entry. Returns null if filtered out. */
function resolve(
  names: string[],
  key: string,
  agent?: string,
): { suffix: string; extra: string } | null {
  if (agent) {
    if (!names.includes("agent")) return null;
    // Parse the label we need from the key
    const p = `agent="`;
    const i = key.indexOf(p);
    if (
      i === -1 ||
      key.slice(i + p.length, key.indexOf('"', i + p.length)) !== agent
    ) return null;
    // Strip the agent label, keep the rest
    const stripped = names.filter((n) => n !== "agent")
      .map((n) => {
        const np = `${n}="`;
        const ni = key.indexOf(np);
        if (ni === -1) return `${n}=""`;
        const ns = ni + np.length;
        return `${n}="${key.slice(ns, key.indexOf('"', ns))}"`;
      }).join(",");
    return {
      suffix: stripped ? `{${stripped}}` : "",
      extra: stripped ? `,${stripped}` : "",
    };
  }
  return {
    suffix: key ? `{${key}}` : "",
    extra: key ? `,${key}` : "",
  };
}

/** Serialize a simple metric (counter or gauge). */
function serializeSimple(
  name: string,
  type: string,
  help: string,
  labelNames: string[],
  values: Map<string, number>,
  agent?: string,
): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const [key, val] of values) {
    const r = resolve(labelNames, key, agent);
    if (r) lines.push(`${name}${r.suffix} ${val}`);
  }
  return lines.join("\n");
}

type Counter = {
  inc(labels?: Labels, n?: number): void;
  serialize(agent?: string): string;
};

type Gauge = {
  inc(labels?: Labels): void;
  dec(labels?: Labels): void;
  serialize(agent?: string): string;
};

type Histogram = {
  observe(value: number, labels?: Labels): void;
  serialize(agent?: string): string;
};

function createCounter(
  name: string,
  opts: { help: string; labelNames?: string[] },
): Counter {
  const { help, labelNames = [] } = opts;
  const values = new Map<string, number>();
  if (labelNames.length === 0) values.set("", 0);
  return {
    inc(labels?: Labels, n = 1) {
      const key = toKey(labelNames, labels);
      values.set(key, (values.get(key) ?? 0) + n);
    },
    serialize(agent?: string) {
      return serializeSimple(name, "counter", help, labelNames, values, agent);
    },
  };
}

function createGauge(
  name: string,
  opts: { help: string; labelNames?: string[] },
): Gauge {
  const { help, labelNames = [] } = opts;
  const values = new Map<string, number>();
  if (labelNames.length === 0) values.set("", 0);
  return {
    inc(labels?: Labels) {
      const key = toKey(labelNames, labels);
      values.set(key, (values.get(key) ?? 0) + 1);
    },
    dec(labels?: Labels) {
      const key = toKey(labelNames, labels);
      values.set(key, (values.get(key) ?? 0) - 1);
    },
    serialize(agent?: string) {
      return serializeSimple(name, "gauge", help, labelNames, values, agent);
    },
  };
}

type HistogramEntry = { counts: number[]; sum: number; count: number };

function createHistogram(
  name: string,
  opts: { help: string; buckets?: number[]; labelNames?: string[] },
): Histogram {
  const { help, buckets = DEFAULT_BUCKETS, labelNames = [] } = opts;
  const entries = new Map<string, HistogramEntry>();

  function getEntry(key: string): HistogramEntry {
    let e = entries.get(key);
    if (!e) {
      e = { counts: new Array(buckets.length).fill(0), sum: 0, count: 0 };
      entries.set(key, e);
    }
    return e;
  }

  if (labelNames.length === 0) getEntry("");

  return {
    observe(value: number, labels?: Labels) {
      const e = getEntry(toKey(labelNames, labels));
      e.sum += value;
      e.count++;
      for (let i = 0; i < buckets.length; i++) {
        if (value <= buckets[i]!) e.counts[i] = (e.counts[i] ?? 0) + 1;
      }
    },

    serialize(agent?: string) {
      const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
      for (const [key, e] of entries) {
        const r = resolve(labelNames, key, agent);
        if (!r) continue;
        for (let i = 0; i < buckets.length; i++) {
          lines.push(
            `${name}_bucket{le="${buckets[i]}"${r.extra}} ${e.counts[i]}`,
          );
        }
        lines.push(`${name}_bucket{le="+Inf"${r.extra}} ${e.count}`);
        lines.push(`${name}_sum${r.suffix} ${e.sum}`);
        lines.push(`${name}_count${r.suffix} ${e.count}`);
      }
      return lines.join("\n");
    },
  };
}

/** @internal Exposed for unit tests only. */
export const _internals = { createCounter, createGauge, createHistogram };

export const httpRequestsTotal = createCounter(
  "http_requests_total",
  {
    help: "Total number of HTTP requests",
    labelNames: ["method", "route", "status", "ok"],
  },
);

export const httpRequestDurationSeconds = createHistogram(
  "http_request_duration_seconds",
  {
    help: "Duration of HTTP requests in seconds",
    buckets: HTTP_BUCKETS,
    labelNames: ["method", "route", "status", "ok"],
  },
);

type Metric = { serialize(agent?: string): string };

const metrics: Metric[] = [
  httpRequestsTotal,
  httpRequestDurationSeconds,
];

export function serialize(): string {
  return metrics.map((m) => m.serialize()).join("\n\n") + "\n";
}

export function serializeForAgent(agent: string): string {
  return metrics.map((m) => m.serialize(agent)).join("\n\n") + "\n";
}
