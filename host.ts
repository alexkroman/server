// Copyright 2025 the AAI authors. MIT license.
/**
 * Host-side helpers for managing sandboxed workers.
 * Provides `createHostEndpoint` factory that registers all standard
 * host→worker RPC methods for server implementations.
 *
 * @module
 */

import {
  bridgeWebSocketToPort,
  createRpcSession,
  isTransferMessage,
  RpcTarget,
  sendTransfer,
  type WorkerPort,
} from "@aai/sdk/capnweb";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Serialized fetch response for RPC transport. */
type FetchResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/** Fetch function signature for host→worker RPC. */
type HostFetchFn = (
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
) => Promise<FetchResult>;

/** KV interface with optional key-listing support. */
type KvWithKeys = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(
    prefix: string,
    options?: { limit?: number; reverse?: boolean },
  ): Promise<{ key: string; value: unknown }[]>;
  keys?(pattern?: string): Promise<string[]>;
};

/** Vector store interface. */
type VectorStore = {
  upsert(
    id: string,
    data: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  query(
    text: string,
    options?: { topK?: number; filter?: string },
  ): Promise<unknown[]>;
  remove(ids: string | string[]): Promise<void>;
};

/** Options for {@linkcode createHostEndpoint}. */
type HostEndpointOptions = {
  env: Record<string, string>;
  kv: KvWithKeys;
  vector?: VectorStore | undefined;
  fetch: HostFetchFn;
  createWebSocket(
    url: string,
    headers: Record<string, string>,
    port: MessagePort,
  ): void;
};

/** A host-side sandbox created by {@linkcode createHostEndpoint}. */
export type HostSandbox = {
  startSession(
    socket: Parameters<typeof bridgeWebSocketToPort>[0],
    skipGreeting?: boolean,
  ): void;
  fetch(request: Request): Promise<Response>;
};

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max size for a single audio chunk from the browser (1 MB). */
const MAX_AUDIO_CHUNK_BYTES = 1_048_576;

/** Validate a PCM16 audio chunk: non-empty, within size bounds, even byte length. */
function isValidAudioChunk(data: { byteLength: number }): boolean {
  return (
    data.byteLength > 0 &&
    data.byteLength <= MAX_AUDIO_CHUNK_BYTES &&
    data.byteLength % 2 === 0
  );
}

// ─── Default fetch ──────────────────────────────────────────────────────────

/** Execute an HTTP fetch on behalf of the sandboxed worker. */
export async function defaultHostFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<FetchResult> {
  const response = await fetch(
    new Request(url, { method, headers, ...(body ? { body } : {}) }),
  );
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}

// ─── Host RPC service ───────────────────────────────────────────────────────

/** Convert a void promise to null (capnweb RPC requires a return value). */
async function voidToNull(p: Promise<void>): Promise<null> {
  await p;
  return null;
}

/**
 * RPC service exposed by the host to the sandboxed worker.
 * Methods are callable via capnweb RPC stubs.
 */
class HostService extends RpcTarget {
  #kv: KvWithKeys;
  #vec: VectorStore | undefined;
  #fetchFn: HostFetchFn;

  constructor(
    kv: KvWithKeys,
    vec: VectorStore | undefined,
    fetchFn: HostFetchFn,
  ) {
    super();
    this.#kv = kv;
    this.#vec = vec;
    this.#fetchFn = fetchFn;
  }

  hostFetch(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
  ) {
    return this.#fetchFn(url, method, headers, body);
  }

  kvGet(key: string) {
    return this.#kv.get(key);
  }

  kvSet(key: string, value: unknown, options?: { expireIn?: number }) {
    return voidToNull(this.#kv.set(key, value, options));
  }

  kvDel(key: string) {
    return voidToNull(this.#kv.delete(key));
  }

  kvList(
    prefix: string,
    options?: { limit?: number; reverse?: boolean },
  ) {
    return this.#kv.list(prefix, options);
  }

  kvKeys(pattern?: string) {
    if (!this.#kv.keys) throw new Error("keys op not supported");
    return this.#kv.keys(pattern);
  }

  #requireVec(): VectorStore {
    if (!this.#vec) throw new Error("Vector store not configured");
    return this.#vec;
  }

  vecUpsert(id: string, data: string, metadata?: Record<string, unknown>) {
    return voidToNull(this.#requireVec().upsert(id, data, metadata));
  }

  vecQuery(text: string, options?: { topK?: number; filter?: string }) {
    return this.#requireVec().query(text, options);
  }

  vecRemove(ids: string[]) {
    return voidToNull(this.#requireVec().remove(ids));
  }
}

// ─── Endpoint factory ───────────────────────────────────────────────────────

/**
 * Create a host endpoint for a sandboxed worker.
 * Sets up capnweb RPC with a HostService, initializes the worker,
 * and returns a {@linkcode HostSandbox} with `startSession` and `fetch`.
 */
export async function createHostEndpoint(
  port: WorkerPort,
  opts: HostEndpointOptions,
): Promise<HostSandbox> {
  const hostService = new HostService(opts.kv, opts.vector, opts.fetch);

  // deno-lint-ignore no-explicit-any
  const workerStub: any = createRpcSession({
    port,
    localMain: hostService,
    onTransfer(
      data: Record<string, unknown>,
      ports: readonly MessagePort[],
    ) {
      if (!isTransferMessage(data)) return;
      if ((data as { _t: string })._t === "createWs") {
        const transferPort = ports[0];
        if (!transferPort) {
          throw new Error("No port transferred for WebSocket");
        }
        const headers = JSON.parse(
          (data as { headers: string }).headers,
        ) as Record<string, string>;
        opts.createWebSocket(
          (data as { url: string }).url,
          headers,
          transferPort,
        );
      }
    },
  });

  // Initialize the worker
  await workerStub.init(opts.env);

  return {
    startSession(socket, skipGreeting) {
      const { port1, port2 } = new MessageChannel();
      bridgeWebSocketToPort(socket, port1, {
        filterBinary: isValidAudioChunk,
      });
      sendTransfer(
        port,
        { _t: "handleWs", skipGreeting: skipGreeting ?? false },
        [port2],
      );
    },
    async fetch(request) {
      const body = request.body ? await request.text() : undefined;
      const result = await workerStub.workerFetch(
        request.url,
        request.method,
        Object.fromEntries(request.headers),
        body,
      );
      return new Response(result.body, {
        status: result.status,
        headers: result.headers,
      });
    },
  };
}
