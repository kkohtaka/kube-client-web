import { describe, expect, it } from "vitest";
import { ApiError, createClient, defineResource, type KubeObject } from "./index.ts";

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
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function only(calls: Call[]): Call {
  expect(calls).toHaveLength(1);
  return calls[0] as Call;
}

interface ConfigMap extends KubeObject {
  data?: Record<string, string>;
}

const configMaps = defineResource<ConfigMap>({
  version: "v1",
  resource: "configmaps",
  namespaced: true,
});
const baseUrl = "https://k8s.example.test";

describe("authentication", () => {
  it("sends a static token as a bearer token", async () => {
    const { fetch, calls } = fakeFetch(json({ items: [] }));
    await createClient({ baseUrl, token: "abc", fetch }).resource(configMaps).list();
    expect(only(calls).headers.get("Authorization")).toBe("Bearer abc");
  });

  it("asks a token function for a fresh token on every request", async () => {
    const { fetch, calls } = fakeFetch(json({ items: [] }), json({ items: [] }));
    let n = 0;
    const client = createClient({ baseUrl, token: async () => `token-${++n}`, fetch });
    await client.resource(configMaps).list();
    await client.resource(configMaps).list();
    expect(calls.map((call) => call.headers.get("Authorization"))).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
  });

  it("sends no Authorization header without a token", async () => {
    const { fetch, calls } = fakeFetch(json({ items: [] }));
    await createClient({ baseUrl, fetch }).resource(configMaps).list();
    expect(only(calls).headers.has("Authorization")).toBe(false);
  });
});

describe("requests", () => {
  it("keeps a path prefix on the base URL", async () => {
    const { fetch, calls } = fakeFetch(json({ items: [] }));
    await createClient({ baseUrl: `${baseUrl}/proxy/`, fetch })
      .resource(configMaps)
      .list();
    expect(only(calls).url.pathname).toBe("/proxy/api/v1/configmaps");
  });

  it("lists with selectors and paging parameters, omitting unset ones", async () => {
    const { fetch, calls } = fakeFetch(json({ items: [] }));
    await createClient({ baseUrl, fetch })
      .resource(configMaps)
      .list({ namespace: "team-a", labelSelector: "app=web,tier!=db", limit: 50 });
    const { url, method } = only(calls);
    expect(method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/namespaces/team-a/configmaps");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      labelSelector: "app=web,tier!=db",
      limit: "50",
    });
  });

  it("gets a subresource", async () => {
    const { fetch, calls } = fakeFetch(json({}));
    const deployments = defineResource({
      group: "apps",
      version: "v1",
      resource: "deployments",
      namespaced: true,
    });
    await createClient({ baseUrl, fetch })
      .resource(deployments)
      .get("web", { namespace: "team-a", subresource: "status" });
    expect(only(calls).url.pathname).toBe("/apis/apps/v1/namespaces/team-a/deployments/web/status");
  });

  it("creates in the namespace taken from the object", async () => {
    const { fetch, calls } = fakeFetch(json({}, 201));
    const object: ConfigMap = { metadata: { name: "cm", namespace: "team-a" }, data: { k: "v" } };
    await createClient({ baseUrl, fetch }).resource(configMaps).create(object, { dryRun: "All" });
    const call = only(calls);
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe("/api/v1/namespaces/team-a/configmaps");
    expect(call.url.searchParams.get("dryRun")).toBe("All");
    expect(call.headers.get("Content-Type")).toBe("application/json");
    expect(call.body).toEqual(object);
  });

  it("updates with PUT at the object's own path", async () => {
    const { fetch, calls } = fakeFetch(json({}));
    await createClient({ baseUrl, fetch })
      .resource(configMaps)
      .update({ metadata: { name: "cm", namespace: "team-a", resourceVersion: "7" } });
    const call = only(calls);
    expect(call.method).toBe("PUT");
    expect(call.url.pathname).toBe("/api/v1/namespaces/team-a/configmaps/cm");
  });

  it("refuses to update an object without a name", () => {
    const { fetch } = fakeFetch();
    const resource = createClient({ baseUrl, fetch }).resource(configMaps);
    expect(() => resource.update({ metadata: { namespace: "team-a" } })).toThrow(/metadata.name/);
  });

  it.each([
    ["merge", "application/merge-patch+json"],
    ["strategic", "application/strategic-merge-patch+json"],
    ["json", "application/json-patch+json"],
  ] as const)("sends a %s patch as %s", async (type, contentType) => {
    const { fetch, calls } = fakeFetch(json({}));
    await createClient({ baseUrl, fetch })
      .resource(configMaps)
      .patch("cm", { data: { k: "v2" } }, { namespace: "team-a", type });
    const call = only(calls);
    expect(call.method).toBe("PATCH");
    expect(call.headers.get("Content-Type")).toBe(contentType);
    expect(call.url.search).toBe("");
  });

  it("defaults to a merge patch", async () => {
    const { fetch, calls } = fakeFetch(json({}));
    await createClient({ baseUrl, fetch })
      .resource(configMaps)
      .patch("cm", {}, { namespace: "team-a" });
    expect(only(calls).headers.get("Content-Type")).toBe("application/merge-patch+json");
  });

  it("applies with the apply media type, field manager and force", async () => {
    const { fetch, calls } = fakeFetch(json({}));
    await createClient({ baseUrl, fetch })
      .resource(configMaps)
      .apply(
        { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cm", namespace: "team-a" } },
        { fieldManager: "demo", force: true },
      );
    const call = only(calls);
    expect(call.method).toBe("PATCH");
    expect(call.url.pathname).toBe("/api/v1/namespaces/team-a/configmaps/cm");
    expect(call.headers.get("Content-Type")).toBe("application/apply-patch+yaml");
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      fieldManager: "demo",
      force: "true",
    });
  });

  it("deletes without a body by default", async () => {
    const { fetch, calls } = fakeFetch(json({ kind: "Status", status: "Success" }));
    await createClient({ baseUrl, fetch })
      .resource(configMaps)
      .delete("cm", { namespace: "team-a" });
    const call = only(calls);
    expect(call.method).toBe("DELETE");
    expect(call.body).toBeUndefined();
    expect(call.headers.has("Content-Type")).toBe(false);
  });

  it("sends delete options in the body", async () => {
    const { fetch, calls } = fakeFetch(json({ kind: "Status", status: "Success" }));
    await createClient({ baseUrl, fetch })
      .resource(configMaps)
      .delete("cm", {
        namespace: "team-a",
        propagationPolicy: "Foreground",
        preconditions: { resourceVersion: "7" },
      });
    expect(only(calls).body).toEqual({
      apiVersion: "v1",
      kind: "DeleteOptions",
      propagationPolicy: "Foreground",
      preconditions: { resourceVersion: "7" },
    });
  });

  it("passes the abort signal through", async () => {
    const { fetch, calls } = fakeFetch(json({ items: [] }));
    const controller = new AbortController();
    await createClient({ baseUrl, fetch }).resource(configMaps).list({ signal: controller.signal });
    expect(only(calls).signal).toBe(controller.signal);
  });
});

describe("paging", () => {
  it("follows continue tokens until the last page", async () => {
    const { fetch, calls } = fakeFetch(
      json({ metadata: { continue: "t1" }, items: [{ metadata: { name: "a" } }] }),
      json({ metadata: { continue: "t2" }, items: [{ metadata: { name: "b" } }] }),
      json({ metadata: { continue: "" }, items: [{ metadata: { name: "c" } }] }),
    );
    const names: (string | undefined)[] = [];
    const pages = createClient({ baseUrl, fetch })
      .resource(configMaps)
      .listPages({ namespace: "team-a", limit: 1 });
    for await (const page of pages) {
      names.push(...page.items.map((item) => item.metadata?.name));
    }
    expect(names).toEqual(["a", "b", "c"]);
    expect(calls.map((call) => call.url.searchParams.get("continue"))).toEqual([null, "t1", "t2"]);
    expect(calls.every((call) => call.url.searchParams.get("limit") === "1")).toBe(true);
  });

  it("does not request the next page until asked", async () => {
    const { fetch, calls } = fakeFetch(json({ metadata: { continue: "t1" }, items: [] }));
    const pages = createClient({ baseUrl, fetch }).resource(configMaps).listPages();
    await pages.next();
    expect(calls).toHaveLength(1);
    await pages.return();
  });
});

describe("errors", () => {
  it("throws an ApiError carrying the Status body", async () => {
    const status = {
      kind: "Status",
      status: "Failure",
      message: 'configmaps "cm" not found',
      reason: "NotFound",
      code: 404,
    };
    const { fetch } = fakeFetch(json(status, 404));
    const error = await createClient({ baseUrl, fetch })
      .resource(configMaps)
      .get("cm", { namespace: "team-a" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(404);
    expect(apiError.reason).toBe("NotFound");
    expect(apiError.message).toBe('configmaps "cm" not found');
    expect(apiError.body).toEqual(status);
  });

  it("falls back to the response text when the body is not a Status", async () => {
    const { fetch } = fakeFetch(new Response("upstream timed out\n", { status: 504 }));
    const error = await createClient({ baseUrl, fetch })
      .resource(configMaps)
      .list()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(504);
    expect(apiError.body).toBeUndefined();
    expect(apiError.reason).toBeUndefined();
    expect(apiError.message).toBe("upstream timed out");
  });

  it("falls back to the status code when the body is empty", async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 503 }));
    const error = await createClient({ baseUrl, fetch })
      .resource(configMaps)
      .list()
      .catch((e: unknown) => e);
    expect((error as ApiError).message).toBe("HTTP 503");
  });
});
