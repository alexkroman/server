# CLAUDE.md

## Overview

AAI platform server — multi-tenant voice agent hosting. Receives bundled agents
from the `aai` CLI, runs them in sandboxed Deno Workers, and orchestrates
real-time STT → LLM → TTS over WebSocket.

This is the **platform** component. The **framework** (`aai` npm package) lives
in a separate repository.

## Commands

```sh
deno task setup          # Configure git hooks (run after clone)
deno task serve          # Run the orchestrator server
deno task check          # Full CI (type-check, lint, fmt, tests)
deno task test           # Run Deno tests
```

Run a single test file: `deno test --allow-all orchestrator_test.ts`

## Architecture

Deno server that depends on the `aai` npm package for shared types and
orchestration logic.

### Key Files

- `orchestrator.ts` — deploy, health, WebSocket, landing page routes
- `sandbox.ts` — sandboxed Deno Workers (all permissions false), idle eviction,
  host-side RPC bindings (fetch proxy, KV, vector)
- `transport_websocket.ts` — WebSocket transport handler
- `session_s2s.ts` — thin wrapper over `aai/session`, injects metrics
- `ws_handler.ts` — thin wrapper over `aai/ws-handler`, injects logger
- `bundle_store_tigris.ts` — S3 bundle storage
- `kv.ts` — Managed Upstash Redis KV
- `vector.ts` — Managed Upstash Vector store
- `credentials.ts` — Env var encryption
- `auth.ts` / `middleware.ts` — Auth, CORS
- `metrics.ts` — Prometheus metrics

### Agent Isolation

Agent code runs in Deno Workers with **all permissions false** (including
`net: false`). The worker communicates with the host via capnweb RPC. Custom
tool `execute` functions run inside the worker; built-in tools run on the host.

**Fetch proxy**: Since workers have no network access, `globalThis.fetch` is
monkeypatched in the worker shim to proxy HTTP requests through RPC to the host
process. The host validates each URL via `assertPublicUrl()` to block requests
to private/internal addresses (SSRF protection).

## Conventions

- **Runtime**: Deno (Workers with permission sandboxing — load-bearing for agent
  isolation)
- **Testing**: `Deno.test()`. Test files are co-located: `foo.ts` →
  `foo_test.ts`
- **Framework dependency**: Import from `@aai/sdk/*` (mapped to
  `npm:@alexkroman1/aai@^0.5/*` in deno.json imports)
