import type { KubeClient } from "./client.ts";

export interface LogOptions {
  /** Namespace of the pod. */
  namespace?: string | undefined;
  /** Container to read. May be omitted when the pod has only one. */
  container?: string | undefined;
  /** Read the log of the container's previous run, from before it restarted. */
  previous?: boolean | undefined;
  /** Only the last lines, this many. */
  tailLines?: number | undefined;
  /** Only what was written in the last seconds, this many. */
  sinceSeconds?: number | undefined;
  /** Only what was written at or after this time, as an RFC 3339 timestamp. */
  sinceTime?: string | undefined;
  /** Start every line with the time it was written, as an RFC 3339 timestamp. */
  timestamps?: boolean | undefined;
  /** Stop after roughly this many bytes. */
  limitBytes?: number | undefined;
  signal?: AbortSignal | undefined;
}

function request(
  client: KubeClient,
  path: string,
  options: Omit<LogOptions, "namespace">,
  follow: boolean,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const { signal: _, ...query } = options;
  return client.fetchResponse({
    path,
    query: { ...query, follow: follow || undefined },
    // The log is plain text; a refusal still arrives as a Status in JSON.
    accept: "text/plain, application/json",
    signal,
  });
}

/** Reads the log as it is now. */
export async function readLog(
  client: KubeClient,
  path: string,
  options: Omit<LogOptions, "namespace">,
): Promise<string> {
  const response = await request(client, path, options, false, options.signal);
  return response.text();
}

/**
 * Reads the log and keeps reading as it grows, one line at a time. Ends when
 * the server closes the connection, which it does when the container stops.
 */
export async function* followLog(
  client: KubeClient,
  path: string,
  options: Omit<LogOptions, "namespace">,
): AsyncGenerator<string, void, undefined> {
  const { signal } = options;
  const teardown = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, teardown.signal]) : teardown.signal;

  // As for a watch: WebKit can leave a read pending after the request was
  // aborted, so every wait also ends by itself.
  const aborted = new Promise<never>((_, reject) => {
    const fail = (): void => reject(requestSignal.reason);
    if (requestSignal.aborted) {
      fail();
    } else {
      requestSignal.addEventListener("abort", fail, { once: true });
    }
  });
  aborted.catch(() => undefined);
  function waitFor<R>(pending: Promise<R>): Promise<R> {
    pending.catch(() => undefined);
    return Promise.race([pending, aborted]);
  }

  try {
    const response = await waitFor(request(client, path, options, true, requestSignal));
    if (!response.body) {
      throw new Error("the log response has no body");
    }

    // The text arrives in chunks that end anywhere, also inside a character.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await waitFor(reader.read());
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // What follows the last newline is a line still being written.
      buffer = lines.pop() ?? "";
      yield* lines;
      if (done) {
        // A log that does not end with a newline still ends with a line.
        if (buffer !== "") {
          yield buffer;
        }
        return;
      }
    }
  } catch (error) {
    // Not every fetch implementation rejects with the reason it was aborted with.
    if (signal?.aborted) {
      throw signal.reason;
    }
    throw error;
  } finally {
    teardown.abort();
  }
}
