import { Backoff, type BackoffOptions, sleep } from "./backoff.ts";
import type { KubeClient } from "./client.ts";
import { ApiError } from "./errors.ts";
import type { KubeObject, Status } from "./types.ts";

/** One change reported by a watch. */
export type WatchEvent<T> =
  | { type: "ADDED" | "MODIFIED" | "DELETED"; object: T }
  /**
   * Carries no change. Only `object.metadata.resourceVersion` is meaningful: a
   * watch restarted from it misses nothing.
   */
  | { type: "BOOKMARK"; object: KubeObject };

export interface WatchOptions {
  /** Namespace to watch. Omit to watch a namespaced resource across all namespaces. */
  namespace?: string | undefined;
  labelSelector?: string | undefined;
  fieldSelector?: string | undefined;
  /**
   * Report changes made after this version, normally `metadata.resourceVersion`
   * of a list. Without it the watch starts at the current state and first
   * reports every existing object as `ADDED`.
   */
  resourceVersion?: string | undefined;
  /** Ask the server for periodic `BOOKMARK` events. Defaults to `true`. */
  allowWatchBookmarks?: boolean | undefined;
  /**
   * Ask the server to end the watch after this many seconds. If the connection
   * is still open `closeGraceMs` after that, it is taken for dead and the watch
   * gives up with a {@link WatchTimeoutError}.
   */
  timeoutSeconds?: number | undefined;
  /**
   * How long past `timeoutSeconds` to wait for the server to end the watch.
   * Defaults to 30000.
   */
  closeGraceMs?: number | undefined;
  /**
   * Give up with a {@link WatchTimeoutError} when the server sends nothing
   * for this long. Guards against connections that died without the browser
   * noticing, for example after the machine slept, sooner than
   * `timeoutSeconds` does. With bookmarks enabled the API server normally
   * sends something about once a minute.
   */
  idleTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ReconnectInfo {
  /** Why the connection ended; `undefined` when the server closed it normally. */
  error: unknown;
  /** How long the watch waits before connecting again. */
  delayMs: number;
  /** The version the next connection resumes from. */
  resourceVersion: string | undefined;
}

export interface ReconnectingWatchOptions extends WatchOptions {
  backoff?: BackoffOptions | undefined;
  /** Called each time the connection ended and the watch is about to reconnect. */
  onReconnect?: ((info: ReconnectInfo) => void) | undefined;
}

/**
 * Thrown by a watch whose connection looks dead: nothing arrived within
 * `idleTimeoutMs`, or the server did not end the watch when it was asked to.
 */
export class WatchTimeoutError extends Error {
  override readonly name: string = "WatchTimeoutError";
}

/** Runs one watch request and yields its events until the server ends it. */
export async function* watchOnce<T extends KubeObject>(
  client: KubeClient,
  path: string,
  options: Omit<WatchOptions, "namespace">,
): AsyncGenerator<WatchEvent<T>, void, undefined> {
  const {
    signal,
    idleTimeoutMs,
    closeGraceMs = 30_000,
    allowWatchBookmarks = true,
    ...query
  } = options;
  // The server ends the watch by itself after timeoutSeconds. A connection
  // that outlives that has died without the browser noticing.
  const overdueAt =
    query.timeoutSeconds === undefined
      ? Number.POSITIVE_INFINITY
      : Date.now() + query.timeoutSeconds * 1000 + closeGraceMs;

  // Aborting this controller is how the request is torn down, both by the
  // timers and when the consumer stops iterating.
  const teardown = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, teardown.signal]) : teardown.signal;

  // The timer only runs while waiting for the server, so a slow consumer does
  // not trip it.
  async function waitFor<R>(promise: Promise<R>): Promise<R> {
    const untilOverdue = overdueAt - Date.now();
    const idle = idleTimeoutMs ?? Number.POSITIVE_INFINITY;
    const delay = Math.min(idle, untilOverdue);
    if (delay === Number.POSITIVE_INFINITY) {
      return promise;
    }
    const message =
      idle <= untilOverdue
        ? `the watch received nothing for ${idle} ms`
        : "the server did not end the watch when it was due";
    const timer = setTimeout(
      () => teardown.abort(new WatchTimeoutError(message)),
      Math.max(delay, 0),
    );
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const response = await waitFor(
      client.fetchResponse({
        path,
        query: { ...query, watch: true, allowWatchBookmarks },
        signal: requestSignal,
      }),
    );
    if (!response.body) {
      throw new Error("the watch response has no body");
    }

    // The body is one JSON document per line, delivered in arbitrary chunks.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await waitFor(reader.read());
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Without a trailing newline the last piece is incomplete, unless the stream is over.
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (line.trim() !== "") {
          yield parseEvent<T>(line);
        }
      }
      if (done) {
        return;
      }
    }
  } catch (error) {
    // Not every fetch implementation rejects with the reason it was aborted with.
    if (teardown.signal.reason instanceof WatchTimeoutError) {
      throw teardown.signal.reason;
    }
    throw error;
  } finally {
    teardown.abort();
  }
}

/**
 * Keeps a watch running across connections, resuming each one from the last
 * version seen. Ends only by throwing.
 */
export async function* watchWithReconnect<T extends KubeObject>(
  client: KubeClient,
  path: string,
  options: Omit<ReconnectingWatchOptions, "namespace">,
): AsyncGenerator<WatchEvent<T>, void, undefined> {
  const { backoff: backoffOptions, onReconnect, ...watchOptions } = options;
  const { signal } = watchOptions;
  const backoff = new Backoff(backoffOptions);
  let resourceVersion = watchOptions.resourceVersion;

  for (;;) {
    let progressed = false;
    let failure: unknown;
    let failed = false;
    try {
      for await (const event of watchOnce<T>(client, path, { ...watchOptions, resourceVersion })) {
        progressed = true;
        backoff.reset();
        resourceVersion = event.object.metadata?.resourceVersion ?? resourceVersion;
        yield event;
      }
    } catch (error) {
      if (signal?.aborted || !isRetryable(error)) {
        throw error;
      }
      failure = error;
      failed = true;
    }

    // A connection that delivered events and was then closed by the server is
    // the normal end of a watch; anything else waits before the next attempt.
    let delayMs = failed || !progressed ? backoff.next() : 0;
    if (failure instanceof ApiError) {
      delayMs = Math.max(delayMs, (failure.body?.details?.retryAfterSeconds ?? 0) * 1000);
    }
    onReconnect?.({ error: failure, delayMs, resourceVersion });
    await sleep(delayMs, signal);
  }
}

function parseEvent<T>(line: string): WatchEvent<T> {
  const event = JSON.parse(line) as { type: string; object: unknown };
  if (event.type === "ERROR") {
    // The request itself succeeded, so the failure arrives in the stream.
    const status = event.object as Status | undefined;
    throw new ApiError(status?.code ?? 500, status, "the watch ended with an error");
  }
  return event as WatchEvent<T>;
}

/**
 * Whether connecting again can help. Server-side trouble and throttling pass;
 * other answers from the API server (expired version, missing permission,
 * unknown resource) will not change by retrying. Everything that is not an
 * answer from the API server is a connection problem.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}
