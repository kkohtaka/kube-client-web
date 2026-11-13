/** Test support; not part of the package. */

export interface Watch {
  url: URL;
  headers: Headers;
  signal: AbortSignal;
  send(...events: unknown[]): void;
  close(): void;
  fail(error: unknown): void;
}

/**
 * A `fetch` stand-in for an API server. List requests are answered from the
 * `lists` queue; each watch request opens a stream the test writes to.
 */
export function fakeServer(): {
  fetch: typeof globalThis.fetch;
  lists: (Response | Error)[];
  listRequests: { url: URL; headers: Headers }[];
  watches: Watch[];
  /** Resolves once the watch with this index has been opened. */
  watch(index: number): Promise<Watch>;
} {
  const lists: (Response | Error)[] = [];
  const listRequests: { url: URL; headers: Headers }[] = [];
  const watches: Watch[] = [];
  const waiters: (() => void)[] = [];
  const encoder = new TextEncoder();

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.searchParams.get("watch") !== "true") {
      listRequests.push({ url, headers });
      const answer = lists.shift();
      if (answer === undefined) {
        throw new Error(`unexpected list request: ${url}`);
      }
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    }

    const signal = init?.signal ?? new AbortController().signal;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    signal.addEventListener("abort", () => {
      try {
        controller.error(signal.reason);
      } catch {
        // Already closed.
      }
    });
    watches.push({
      url,
      headers,
      signal,
      send: (...events) => {
        for (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      },
      close: () => controller.close(),
      fail: (error) => controller.error(error),
    });
    for (const wake of waiters.splice(0)) {
      wake();
    }
    return new Response(body, { status: 200 });
  };

  async function watch(index: number): Promise<Watch> {
    while (watches.length <= index) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    return watches[index] as Watch;
  }

  return { fetch, lists, listRequests, watches, watch };
}
