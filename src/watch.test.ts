import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createClient,
  defineResource,
  isGone,
  type KubeObject,
  type ReconnectInfo,
  type ResourceClient,
  type WatchEvent,
  WatchTimeoutError,
} from "./index.ts";

interface ConfigMap extends KubeObject {
  data?: Record<string, string>;
}

const configMaps = defineResource<ConfigMap>({
  version: "v1",
  resource: "configmaps",
  namespaced: true,
});

/** One watch request as the fake server sees it. */
interface Connection {
  url: URL;
  headers: Headers;
  signal: AbortSignal;
  /** Sends each value as one line of JSON. */
  send(...events: unknown[]): void;
  sendBytes(bytes: Uint8Array): void;
  close(): void;
  fail(error: unknown): void;
}

/**
 * A `fetch` stand-in for watch requests. Each call opens a connection whose
 * body the test writes to; queue a `Response` or an `Error` in `answers` to
 * have the next call answered with it instead.
 */
function fakeServer(): {
  fetch: typeof globalThis.fetch;
  connections: Connection[];
  answers: (Response | Error)[];
  /** Resolves once the connection with this index has been opened. */
  connection(index: number): Promise<Connection>;
} {
  const connections: Connection[] = [];
  const answers: (Response | Error)[] = [];
  const waiters: (() => void)[] = [];
  const encoder = new TextEncoder();

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const signal = init?.signal ?? new AbortController().signal;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    // A real fetch fails the body when its signal aborts.
    signal.addEventListener("abort", () => {
      try {
        controller.error(signal.reason);
      } catch {
        // Already closed.
      }
    });
    connections.push({
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      signal,
      send: (...events) => {
        for (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      },
      sendBytes: (bytes) => controller.enqueue(bytes),
      close: () => controller.close(),
      fail: (error) => controller.error(error),
    });
    for (const wake of waiters.splice(0)) {
      wake();
    }

    const answer = answers.shift();
    if (answer instanceof Error) {
      throw answer;
    }
    return answer ?? new Response(body, { status: 200 });
  };

  async function connection(index: number): Promise<Connection> {
    while (connections.length <= index) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    return connections[index] as Connection;
  }

  return { fetch, connections, answers, connection };
}

function setup(): { server: ReturnType<typeof fakeServer>; resource: ResourceClient<ConfigMap> } {
  const server = fakeServer();
  const resource = createClient({
    baseUrl: "https://k8s.example.test",
    token: "abc",
    fetch: server.fetch,
  }).resource(configMaps);
  return { server, resource };
}

function added(name: string, resourceVersion: string): WatchEvent<ConfigMap> {
  return { type: "ADDED", object: { metadata: { name, resourceVersion } } };
}

function bookmark(resourceVersion: string): WatchEvent<ConfigMap> {
  return { type: "BOOKMARK", object: { metadata: { resourceVersion } } };
}

function status(code: number, reason: string, extra: object = {}): Response {
  return new Response(
    JSON.stringify({ kind: "Status", status: "Failure", code, reason, message: reason, ...extra }),
    { status: code },
  );
}

async function take<T>(events: AsyncGenerator<T>, count: number): Promise<T[]> {
  const taken: T[] = [];
  while (taken.length < count) {
    const next = await events.next();
    if (next.done) {
      break;
    }
    taken.push(next.value);
  }
  return taken;
}

/** Fails if the promise is still pending, instead of hanging the test. */
function settled<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("still pending")), 1000)),
  ]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("watch", () => {
  it("requests a watch of the collection with bookmarks enabled", async () => {
    const { server, resource } = setup();
    const events = resource.watch({
      namespace: "default",
      resourceVersion: "10",
      labelSelector: "app=web",
      fieldSelector: "metadata.name=a",
      timeoutSeconds: 300,
      idleTimeoutMs: 60_000,
    });
    const first = events.next();
    const connection = await server.connection(0);
    connection.close();
    await first;

    expect(connection.url.pathname).toBe("/api/v1/namespaces/default/configmaps");
    expect(Object.fromEntries(connection.url.searchParams)).toEqual({
      watch: "true",
      allowWatchBookmarks: "true",
      resourceVersion: "10",
      labelSelector: "app=web",
      fieldSelector: "metadata.name=a",
      timeoutSeconds: "300",
    });
    expect(connection.headers.get("Authorization")).toBe("Bearer abc");
  });

  it("watches all namespaces when none is given, and can turn bookmarks off", async () => {
    const { server, resource } = setup();
    const first = resource.watch({ allowWatchBookmarks: false }).next();
    const connection = await server.connection(0);
    connection.close();
    await first;

    expect(connection.url.pathname).toBe("/api/v1/configmaps");
    expect(connection.url.searchParams.get("allowWatchBookmarks")).toBe("false");
  });

  it("yields events as they arrive and ends when the server closes the stream", async () => {
    const { server, resource } = setup();
    const events = resource.watch();
    const first = events.next();
    const connection = await server.connection(0);

    connection.send(added("a", "1"));
    expect((await first).value).toEqual(added("a", "1"));

    connection.send(
      { type: "MODIFIED", object: { metadata: { name: "a", resourceVersion: "2" } } },
      bookmark("3"),
    );
    connection.close();
    expect(await take(events, 5)).toEqual([
      { type: "MODIFIED", object: { metadata: { name: "a", resourceVersion: "2" } } },
      bookmark("3"),
    ]);
  });

  it("reassembles events that are split across chunks, even inside a character", async () => {
    const { server, resource } = setup();
    const events = resource.watch();
    const first = events.next();
    const connection = await server.connection(0);

    const one = { type: "ADDED", object: { metadata: { name: "a" }, data: { text: "日本語" } } };
    const bytes = new TextEncoder().encode(
      `${JSON.stringify(one)}\n${JSON.stringify(added("b", "2"))}\n`,
    );
    const cut = bytes.indexOf(0xe6) + 1; // inside the first multi-byte character
    connection.sendBytes(bytes.slice(0, cut));
    connection.sendBytes(bytes.slice(cut, cut + 20));
    connection.sendBytes(bytes.slice(cut + 20));
    connection.close();

    expect([(await first).value, ...(await take(events, 5))]).toEqual([one, added("b", "2")]);
  });

  it("accepts a last event without a trailing newline", async () => {
    const { server, resource } = setup();
    const events = resource.watch();
    const first = events.next();
    const connection = await server.connection(0);
    connection.sendBytes(new TextEncoder().encode(JSON.stringify(added("a", "1"))));
    connection.close();

    expect((await first).value).toEqual(added("a", "1"));
    expect((await events.next()).done).toBe(true);
  });

  it("throws an ApiError for an ERROR event, such as an expired resource version", async () => {
    const { server, resource } = setup();
    const first = resource.watch({ resourceVersion: "1" }).next();
    const connection = await server.connection(0);
    connection.send({
      type: "ERROR",
      object: { kind: "Status", code: 410, reason: "Expired", message: "too old" },
    });

    const error = await first.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(isGone(error)).toBe(true);
    expect((error as ApiError).reason).toBe("Expired");
    expect((error as ApiError).message).toBe("too old");
    expect(connection.signal.aborted).toBe(true);
  });

  it("throws an ApiError when the request itself is refused", async () => {
    const { server, resource } = setup();
    server.answers.push(status(403, "Forbidden"));
    await expect(resource.watch().next()).rejects.toMatchObject({ status: 403 });
  });

  it("rejects with the abort reason when the signal aborts", async () => {
    const { server, resource } = setup();
    const abort = new AbortController();
    const first = resource.watch({ signal: abort.signal }).next();
    await server.connection(0);

    const reason = new Error("stop");
    abort.abort(reason);
    await expect(settled(first)).rejects.toBe(reason);
  });

  it("cancels the request when the consumer stops iterating", async () => {
    const { server, resource } = setup();
    const events = resource.watch();
    const first = events.next();
    const connection = await server.connection(0);
    connection.send(added("a", "1"));
    await first;

    await events.return();
    expect(connection.signal.aborted).toBe(true);
  });

  it("gives up when nothing arrives within the idle timeout", async () => {
    vi.useFakeTimers();
    const { server, resource } = setup();
    const events = resource.watch({ idleTimeoutMs: 1000 });
    const first = events.next();
    const connection = await server.connection(0);

    // Each event restarts the timer.
    await vi.advanceTimersByTimeAsync(900);
    connection.send(added("a", "1"));
    await first;
    const second = events.next().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(900);
    expect(connection.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    expect(await second).toBeInstanceOf(WatchTimeoutError);
    expect(connection.signal.aborted).toBe(true);
  });

  it("does not count the time the consumer takes as idle", async () => {
    vi.useFakeTimers();
    const { server, resource } = setup();
    const events = resource.watch({ idleTimeoutMs: 1000 });
    const first = events.next();
    const connection = await server.connection(0);
    connection.send(added("a", "1"), added("b", "2"));
    await first;

    await vi.advanceTimersByTimeAsync(5000);
    expect((await events.next()).value).toEqual(added("b", "2"));
  });
});

describe("watchWithReconnect", () => {
  const backoff = { initialDelayMs: 100, maxDelayMs: 400, jitter: 0 };

  it("resumes from the last version seen, including bookmarks", async () => {
    const { server, resource } = setup();
    const events = resource.watchWithReconnect({ namespace: "default", resourceVersion: "5" });
    const pending = take(events, 3);

    const first = await server.connection(0);
    expect(first.url.searchParams.get("resourceVersion")).toBe("5");
    first.send(added("a", "6"), bookmark("9"));
    first.close();

    // The server closed a working connection, so there is no delay.
    const second = await server.connection(1);
    expect(second.url.pathname).toBe("/api/v1/namespaces/default/configmaps");
    expect(second.url.searchParams.get("resourceVersion")).toBe("9");
    second.send(added("b", "10"));

    expect(await pending).toEqual([added("a", "6"), bookmark("9"), added("b", "10")]);
    await events.return();
    expect(second.signal.aborted).toBe(true);
  });

  it("waits longer after each consecutive failure, up to the maximum", async () => {
    vi.useFakeTimers();
    const { server, resource } = setup();
    const delays: number[] = [];
    const events = resource.watchWithReconnect({
      backoff,
      onReconnect: (info) => delays.push(info.delayMs),
    });
    const first = events.next();

    for (let attempt = 0; attempt < 4; attempt++) {
      (await server.connection(attempt)).fail(new TypeError("network error"));
      await vi.advanceTimersByTimeAsync(400);
    }
    expect(delays).toEqual([100, 200, 400, 400]);

    // An event resets the delay.
    const working = await server.connection(4);
    working.send(added("a", "1"));
    await first;
    const second = events.next();
    working.fail(new TypeError("network error"));
    await vi.advanceTimersByTimeAsync(100);
    expect(delays).toEqual([100, 200, 400, 400, 100]);

    (await server.connection(5)).send(added("b", "2"));
    expect((await second).value).toEqual(added("b", "2"));
    await events.return();
  });

  it("does not connect again before the delay has passed", async () => {
    vi.useFakeTimers();
    const { server, resource } = setup();
    server.answers.push(new TypeError("Failed to fetch"));
    const events = resource.watchWithReconnect({ backoff });
    const first = events.next();
    await server.connection(0);

    await vi.advanceTimersByTimeAsync(99);
    expect(server.connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.connections).toHaveLength(2);

    (server.connections[1] as Connection).send(added("a", "1"));
    await first;
    await events.return();
  });

  it("backs off when the server keeps closing the stream without sending anything", async () => {
    vi.useFakeTimers();
    const { server, resource } = setup();
    const infos: ReconnectInfo[] = [];
    const events = resource.watchWithReconnect({
      resourceVersion: "5",
      backoff,
      onReconnect: (info) => infos.push(info),
    });
    const first = events.next();
    (await server.connection(0)).close();
    await vi.advanceTimersByTimeAsync(100);
    (await server.connection(1)).send(added("a", "6"));
    await first;

    expect(infos).toEqual([{ error: undefined, delayMs: 100, resourceVersion: "5" }]);
    await events.return();
  });

  it("reconnects after an idle timeout", async () => {
    vi.useFakeTimers();
    const { server, resource } = setup();
    const errors: unknown[] = [];
    const events = resource.watchWithReconnect({
      idleTimeoutMs: 1000,
      backoff,
      onReconnect: (info) => errors.push(info.error),
    });
    const first = events.next();
    await server.connection(0);
    await vi.advanceTimersByTimeAsync(1100);

    (await server.connection(1)).send(added("a", "1"));
    expect((await first).value).toEqual(added("a", "1"));
    expect(errors).toEqual([expect.any(WatchTimeoutError)]);
    await events.return();
  });

  it("retries server errors and honors the delay a throttling server asks for", async () => {
    vi.useFakeTimers();
    const { server, resource } = setup();
    server.answers.push(
      status(503, "ServiceUnavailable"),
      status(429, "TooManyRequests", { details: { retryAfterSeconds: 2 } }),
    );
    const delays: number[] = [];
    const events = resource.watchWithReconnect({
      backoff,
      onReconnect: (info) => delays.push(info.delayMs),
    });
    const first = events.next();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(2000);

    (await server.connection(2)).send(added("a", "1"));
    await first;
    expect(delays).toEqual([100, 2000]);
    await events.return();
  });

  it("throws when the resource version has expired, without reconnecting", async () => {
    const { server, resource } = setup();
    const events = resource.watchWithReconnect({ resourceVersion: "5", backoff });
    const pending = take(events, 2).catch((e: unknown) => e);
    const connection = await server.connection(0);
    connection.send(added("a", "6"), {
      type: "ERROR",
      object: { kind: "Status", code: 410, reason: "Expired" },
    });

    expect(isGone(await pending)).toBe(true);
    expect(server.connections).toHaveLength(1);
  });

  it("throws answers that retrying cannot change", async () => {
    const { server, resource } = setup();
    server.answers.push(status(403, "Forbidden"));
    await expect(resource.watchWithReconnect({ backoff }).next()).rejects.toMatchObject({
      status: 403,
    });
    expect(server.connections).toHaveLength(1);
  });

  it("stops with the abort reason while connected", async () => {
    const { server, resource } = setup();
    const abort = new AbortController();
    const first = resource.watchWithReconnect({ signal: abort.signal, backoff }).next();
    await server.connection(0);

    const reason = new Error("stop");
    abort.abort(reason);
    await expect(settled(first)).rejects.toBe(reason);
    expect(server.connections).toHaveLength(1);
  });

  it("stops with the abort reason while waiting to reconnect", async () => {
    vi.useFakeTimers();
    const { server, resource } = setup();
    server.answers.push(new TypeError("Failed to fetch"));
    const abort = new AbortController();
    const first = resource
      .watchWithReconnect({ signal: abort.signal, backoff })
      .next()
      .catch((e: unknown) => e);
    await server.connection(0);
    await vi.advanceTimersByTimeAsync(50);

    const reason = new Error("stop");
    abort.abort(reason);
    expect(await first).toBe(reason);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.connections).toHaveLength(1);
  });
});

describe("a connection the server should have ended", () => {
  it("is given up once it is overdue", async () => {
    vi.useFakeTimers();
    const { server, resource } = setup();
    const events = resource.watch({ timeoutSeconds: 10 });
    const first = events.next();
    const connection = await server.connection(0);
    connection.send(added("a", "1"));
    await first;

    // Events do not push the moment the server is due to end the watch.
    const second = events.next().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(39_999);
    expect(connection.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBeInstanceOf(WatchTimeoutError);
    expect(connection.signal.aborted).toBe(true);
  });

  it("waits as long past the timeout as closeGraceMs says", async () => {
    vi.useFakeTimers();
    const { server, resource } = setup();
    const first = resource
      .watch({ timeoutSeconds: 10, closeGraceMs: 500 })
      .next()
      .catch((e: unknown) => e);
    await server.connection(0);
    await vi.advanceTimersByTimeAsync(10_500);
    expect(await first).toBeInstanceOf(WatchTimeoutError);
  });

  it("is replaced by a new one when reconnecting", async () => {
    vi.useFakeTimers();
    const { server, resource } = setup();
    const events = resource.watchWithReconnect({
      resourceVersion: "5",
      timeoutSeconds: 10,
      backoff: { initialDelayMs: 100, jitter: 0 },
    });
    const first = events.next();
    await server.connection(0);
    await vi.advanceTimersByTimeAsync(40_100);

    const second = await server.connection(1);
    expect(second.url.searchParams.get("resourceVersion")).toBe("5");
    second.send(added("a", "6"));
    expect((await first).value).toEqual(added("a", "6"));
    await events.return();
  });
});
