import { describe, expect, it } from "vitest";
import { ApiError, createClient, defineResource, type KubeObject, type Scale } from "./index.ts";

interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | null;
}

/** A `fetch` stand-in that records calls and answers from a queue of responses. */
function fakeFetch(...responses: Response[]): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? null,
    });
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected request");
    }
    return response;
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A response whose body the test writes, chunk by chunk. */
function stream(signal?: AbortSignal): {
  response: Response;
  send(chunk: string | Uint8Array): void;
  close(): void;
  fail(error: unknown): void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal?.addEventListener("abort", () => {
    try {
      controller.error(signal.reason);
    } catch {
      // Already closed.
    }
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200 }),
    send: (chunk) => controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk),
    close: () => controller.close(),
    fail: (error) => controller.error(error),
  };
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const all: string[] = [];
  for await (const line of lines) {
    all.push(line);
  }
  return all;
}

const baseUrl = "https://k8s.example.test";
const pods = defineResource({ version: "v1", resource: "pods", namespaced: true });
const deployments = defineResource({
  group: "apps",
  version: "v1",
  resource: "deployments",
  namespaced: true,
});
const nodes = defineResource({ version: "v1", resource: "nodes", namespaced: false });

const scaleOf = (replicas: number): Scale => ({
  apiVersion: "autoscaling/v1",
  kind: "Scale",
  metadata: { name: "web", namespace: "team-a" },
  spec: { replicas },
  status: { replicas: 2, selector: "app=web" },
});

describe("scale", () => {
  it("reads the scale subresource", async () => {
    const { fetch, calls } = fakeFetch(json(scaleOf(2)));

    const scale = await createClient({ baseUrl, fetch })
      .resource(deployments)
      .getScale("web", { namespace: "team-a" });

    expect(scale.spec?.replicas).toBe(2);
    expect(scale.status?.selector).toBe("app=web");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/apis/apps/v1/namespaces/team-a/deployments/web/scale");
  });

  it("sets the replicas with a merge patch of the subresource", async () => {
    const { fetch, calls } = fakeFetch(json(scaleOf(5)));

    const scale = await createClient({ baseUrl, fetch })
      .resource(deployments)
      .scale("web", 5, { namespace: "team-a", dryRun: "All" });

    expect(scale.spec?.replicas).toBe(5);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url.pathname).toBe("/apis/apps/v1/namespaces/team-a/deployments/web/scale");
    expect(calls[0]?.url.searchParams.get("dryRun")).toBe("All");
    expect(calls[0]?.headers.get("Content-Type")).toBe("application/merge-patch+json");
    expect(calls[0]?.body).toEqual({ spec: { replicas: 5 } });
  });
});

describe("subresource", () => {
  it("gets, replaces and patches any subresource", async () => {
    const { fetch, calls } = fakeFetch(json({ a: 1 }), json({ a: 2 }), json({ a: 3 }));
    const sub = createClient({ baseUrl, fetch })
      .resource(pods)
      .subresource<{ a: number }>("web", "ephemeralcontainers", { namespace: "team-a" });

    expect(await sub.get()).toEqual({ a: 1 });
    expect(await sub.update({ a: 2 }, { fieldManager: "me" })).toEqual({ a: 2 });
    expect(await sub.patch([{ op: "add", path: "/a", value: 3 }], { type: "json" })).toEqual({
      a: 3,
    });

    const path = "/api/v1/namespaces/team-a/pods/web/ephemeralcontainers";
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", path],
      ["PUT", path],
      ["PATCH", path],
    ]);
    expect(calls[1]?.url.searchParams.get("fieldManager")).toBe("me");
    expect(calls[1]?.body).toEqual({ a: 2 });
    expect(calls[2]?.headers.get("Content-Type")).toBe("application/json-patch+json");
  });

  it("posts to a subresource, as an eviction does", async () => {
    const { fetch, calls } = fakeFetch(json({ kind: "Status", status: "Success" }));
    const eviction: KubeObject = {
      apiVersion: "policy/v1",
      kind: "Eviction",
      metadata: { name: "web", namespace: "team-a" },
    };

    await createClient({ baseUrl, fetch })
      .resource(pods)
      .subresource("web", "eviction", { namespace: "team-a" })
      .create(eviction);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/api/v1/namespaces/team-a/pods/web/eviction");
    expect(calls[0]?.body).toEqual(eviction);
  });

  it("addresses subresources of cluster-scoped objects", async () => {
    const { fetch, calls } = fakeFetch(json({}));
    await createClient({ baseUrl, fetch }).resource(nodes).subresource("node-1", "status").get();
    expect(calls[0]?.url.pathname).toBe("/api/v1/nodes/node-1/status");
  });
});

describe("log", () => {
  it("reads the log as text, with the options given", async () => {
    const { fetch, calls } = fakeFetch(new Response("one\ntwo\n"));

    const text = await createClient({ baseUrl, token: "abc", fetch }).resource(pods).log("web", {
      namespace: "team-a",
      container: "app",
      previous: true,
      tailLines: 10,
      sinceSeconds: 60,
      timestamps: true,
      limitBytes: 1000,
    });

    expect(text).toBe("one\ntwo\n");
    const { url, headers } = calls[0] as Call;
    expect(url.pathname).toBe("/api/v1/namespaces/team-a/pods/web/log");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      container: "app",
      previous: "true",
      tailLines: "10",
      sinceSeconds: "60",
      timestamps: "true",
      limitBytes: "1000",
    });
    expect(headers.get("Accept")).toBe("text/plain, application/json");
    expect(headers.get("Authorization")).toBe("Bearer abc");
  });

  it("reports a refusal as an ApiError", async () => {
    const { fetch } = fakeFetch(
      json({ kind: "Status", status: "Failure", reason: "BadRequest", code: 400 }, 400),
    );
    const error = await createClient({ baseUrl, fetch })
      .resource(pods)
      .log("web", { namespace: "team-a" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).reason).toBe("BadRequest");
  });
});

describe("followLog", () => {
  function follow(options: { signal?: AbortSignal } = {}) {
    const body = stream(options.signal);
    const { fetch, calls } = fakeFetch(body.response);
    const lines = createClient({ baseUrl, fetch })
      .resource(pods)
      .followLog("web", { namespace: "team-a", sinceTime: "2026-01-01T00:00:00Z", ...options });
    return { body, calls, lines };
  }

  it("asks the server to keep the log open", async () => {
    const { body, calls, lines } = follow();
    body.close();
    expect(await collect(lines)).toEqual([]);

    const { url } = calls[0] as Call;
    expect(url.pathname).toBe("/api/v1/namespaces/team-a/pods/web/log");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      follow: "true",
      sinceTime: "2026-01-01T00:00:00Z",
    });
  });

  it("yields lines as they are completed, however the text is cut into chunks", async () => {
    const { body, lines } = follow();
    const seen: string[] = [];
    const done = (async () => {
      for await (const line of lines) {
        seen.push(line);
      }
    })();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    body.send("one\ntw");
    await settle();
    expect(seen).toEqual(["one"]);

    body.send("o\n\nthree");
    await settle();
    expect(seen).toEqual(["one", "two", ""]);

    // A log that ends without a line break still ends with a line.
    body.close();
    await done;
    expect(seen).toEqual(["one", "two", "", "three"]);
  });

  it("puts together a character that is split between chunks", async () => {
    const { body, lines } = follow();
    const bytes = new TextEncoder().encode("héllo ✓\n");
    body.send(bytes.slice(0, 2));
    body.send(bytes.slice(2, 8));
    body.send(bytes.slice(8));
    body.close();

    expect(await collect(lines)).toEqual(["héllo ✓"]);
  });

  it("ends with the caller's reason when aborted, also while waiting for the server", async () => {
    const abort = new AbortController();
    const { body, lines } = follow({ signal: abort.signal });
    body.send("one\n");
    const iterator = lines[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe("one");

    const next = iterator.next();
    const reason = new Error("enough");
    abort.abort(reason);

    await expect(next).rejects.toBe(reason);
  });

  it("closes the connection when the caller stops reading", async () => {
    const { body, calls, lines } = follow();
    body.send("one\ntwo\n");
    for await (const line of lines) {
      expect(line).toBe("one");
      break;
    }
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it("throws when the connection is lost", async () => {
    const { body, lines } = follow();
    body.send("one\n");
    const iterator = lines[Symbol.asyncIterator]();
    await iterator.next();

    body.fail(new TypeError("network error"));
    await expect(iterator.next()).rejects.toThrow(TypeError);
  });

  it("reports a refusal as an ApiError", async () => {
    const { fetch } = fakeFetch(
      json({ kind: "Status", status: "Failure", reason: "NotFound", code: 404 }, 404),
    );
    const lines = createClient({ baseUrl, fetch })
      .resource(pods)
      .followLog("gone", { namespace: "team-a" });
    await expect(collect(lines)).rejects.toMatchObject({ status: 404, reason: "NotFound" });
  });
});
