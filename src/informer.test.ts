import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeServer } from "./fake-server.ts";
import { createClient, defineResource, type Informer, type InformerOptions } from "./index.ts";
import type { KubeObject } from "./types.ts";

interface ConfigMap extends KubeObject {
  data?: Record<string, string>;
}

const configMaps = defineResource<ConfigMap>({
  version: "v1",
  resource: "configmaps",
  namespaced: true,
});
const nodes = defineResource({ version: "v1", resource: "nodes", namespaced: false });

function cm(name: string, resourceVersion: string, data?: Record<string, string>): ConfigMap {
  return { metadata: { name, namespace: "default", resourceVersion }, ...(data && { data }) };
}

function list(resourceVersion: string, items: ConfigMap[], next?: string): Response {
  return new Response(
    JSON.stringify({ metadata: { resourceVersion, ...(next && { continue: next }) }, items }),
    { status: 200 },
  );
}

function status(code: number, reason: string): Response {
  return new Response(JSON.stringify({ kind: "Status", code, reason, message: reason }), {
    status: code,
  });
}

const expired = { type: "ERROR", object: { kind: "Status", code: 410, reason: "Expired" } };
const backoff = { initialDelayMs: 100, maxDelayMs: 400, jitter: 0 };

function setup(
  options: InformerOptions = {},
  token: string | (() => string) = "abc",
): {
  server: ReturnType<typeof fakeServer>;
  informer: Informer<ConfigMap>;
  /** Every event reported so far, as `[event, name, ...]`. */
  log: unknown[][];
  errors: unknown[];
} {
  const server = fakeServer();
  const informer = createClient({ baseUrl: "https://k8s.example.test", token, fetch: server.fetch })
    .resource(configMaps)
    .informer({ namespace: "default", backoff, ...options });
  const log: unknown[][] = [];
  const errors: unknown[] = [];
  informer.on("add", (object) => log.push(["add", object.metadata?.name]));
  informer.on("update", (object, previous) =>
    log.push(["update", object.metadata?.name, previous.metadata?.resourceVersion]),
  );
  informer.on("delete", (object) => log.push(["delete", object.metadata?.name]));
  informer.on("error", (error) => errors.push(error));
  running.push(informer);
  return { server, informer, log, errors };
}

/** Lets everything that is ready to run do so. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const running: { stop(): void }[] = [];

afterEach(() => {
  for (const informer of running.splice(0)) {
    informer.stop();
  }
  vi.useRealTimers();
});

describe("Informer", () => {
  it("fills the local copy from a list and reports every object as added", async () => {
    const { server, informer, log } = setup({ labelSelector: "app=web", fieldSelector: "a=b" });
    server.lists.push(list("10", [cm("a", "3"), cm("b", "7")]));

    expect(informer.hasSynced).toBe(false);
    await informer.start();

    expect(informer.hasSynced).toBe(true);
    expect(log).toEqual([
      ["add", "a"],
      ["add", "b"],
    ]);
    expect(informer.list()).toEqual([cm("a", "3"), cm("b", "7")]);
    expect(informer.get("a", "default")).toEqual(cm("a", "3"));
    expect(informer.get("a", "other")).toBeUndefined();
    expect(informer.get("missing", "default")).toBeUndefined();

    const request = server.listRequests[0]?.url;
    expect(request?.pathname).toBe("/api/v1/namespaces/default/configmaps");
    expect(Object.fromEntries(request?.searchParams ?? [])).toEqual({
      labelSelector: "app=web",
      fieldSelector: "a=b",
      limit: "500",
    });
  });

  it("watches from the version of the list, with the same selectors", async () => {
    const { server, informer } = setup({ labelSelector: "app=web", fieldSelector: "a=b" });
    server.lists.push(list("10", []));
    await informer.start();

    const watch = await server.watch(0);
    expect(watch.url.pathname).toBe("/api/v1/namespaces/default/configmaps");
    const query = Object.fromEntries(watch.url.searchParams);
    expect(query).toMatchObject({
      watch: "true",
      allowWatchBookmarks: "true",
      resourceVersion: "10",
      labelSelector: "app=web",
      fieldSelector: "a=b",
    });
    expect(Number(query.timeoutSeconds)).toBeGreaterThanOrEqual(300);
    expect(Number(query.timeoutSeconds)).toBeLessThanOrEqual(600);
  });

  it("follows every page of the list", async () => {
    const { server, informer } = setup({ pageSize: 2, watchTimeoutSeconds: 30 });
    server.lists.push(list("10", [cm("a", "1"), cm("b", "2")], "next"), list("10", [cm("c", "3")]));
    await informer.start();

    expect(informer.list().map((object) => object.metadata?.name)).toEqual(["a", "b", "c"]);
    expect(server.listRequests.map((request) => request.url.searchParams.get("limit"))).toEqual([
      "2",
      "2",
    ]);
    expect(server.listRequests[1]?.url.searchParams.get("continue")).toBe("next");
    const watch = await server.watch(0);
    expect(watch.url.searchParams.get("resourceVersion")).toBe("10");
    expect(watch.url.searchParams.get("timeoutSeconds")).toBe("30");
  });

  it("applies watch events to the local copy and reports them", async () => {
    const { server, informer, log } = setup();
    server.lists.push(list("10", [cm("a", "3")]));
    await informer.start();
    log.length = 0;

    const watch = await server.watch(0);
    watch.send(
      { type: "ADDED", object: cm("b", "11") },
      { type: "MODIFIED", object: cm("a", "12", { x: "1" }) },
      { type: "BOOKMARK", object: { metadata: { resourceVersion: "13" } } },
      { type: "DELETED", object: cm("b", "14") },
      // Events for objects in an unexpected state still leave a consistent copy.
      { type: "ADDED", object: cm("a", "15") },
      { type: "MODIFIED", object: cm("c", "16") },
      { type: "DELETED", object: cm("zzz", "17") },
    );
    await settle();

    expect(log).toEqual([
      ["add", "b"],
      ["update", "a", "3"],
      ["delete", "b"],
      ["update", "a", "12"],
      ["add", "c"],
    ]);
    expect(informer.list()).toEqual([cm("a", "15"), cm("c", "16")]);
  });

  it("shows listeners the local copy as it is after the change", async () => {
    const { server, informer } = setup();
    const seen: unknown[] = [];
    informer.on("add", (object) => seen.push(informer.get(object.metadata?.name ?? "", "default")));
    informer.on("delete", () => seen.push(informer.list().length));
    server.lists.push(list("10", [cm("a", "3")]));
    await informer.start();
    (await server.watch(0)).send({ type: "DELETED", object: cm("a", "11") });
    await settle();

    expect(seen).toEqual([cm("a", "3"), 0]);
  });

  it("lists again when the watch has expired and reports only the differences", async () => {
    const { server, informer, log, errors } = setup();
    server.lists.push(list("10", [cm("a", "3"), cm("b", "7"), cm("c", "8")]));
    await informer.start();
    log.length = 0;

    server.lists.push(list("50", [cm("a", "3"), cm("b", "40"), cm("d", "45")]));
    const first = await server.watch(0);
    first.send({ type: "MODIFIED", object: cm("c", "11") }, expired);

    const second = await server.watch(1);
    expect(second.url.searchParams.get("resourceVersion")).toBe("50");
    expect(log).toEqual([
      ["update", "c", "8"],
      ["update", "b", "7"],
      ["add", "d"],
      ["delete", "c"],
    ]);
    expect(informer.list()).toEqual([cm("a", "3"), cm("b", "40"), cm("d", "45")]);
    // An expired watch is part of normal operation.
    expect(errors).toEqual([]);
    expect(informer.hasSynced).toBe(true);
  });

  it("waits before listing again when the watch expires without having delivered anything", async () => {
    vi.useFakeTimers();
    const { server, informer } = setup();
    server.lists.push(list("10", []), list("20", []));
    await informer.start();
    (await server.watch(0)).send(expired);

    await vi.advanceTimersByTimeAsync(99);
    expect(server.listRequests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.listRequests).toHaveLength(2);
  });

  it("keeps trying when the list fails, and reports each failure", async () => {
    vi.useFakeTimers();
    const { server, informer, errors } = setup();
    server.lists.push(
      new TypeError("Failed to fetch"),
      status(503, "ServiceUnavailable"),
      list("10", [cm("a", "3")]),
    );
    let synced = false;
    const started = informer.start().then(() => {
      synced = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(server.listRequests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(server.listRequests).toHaveLength(2);
    expect(synced).toBe(false);
    expect(informer.hasSynced).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await started;
    expect(errors).toEqual([expect.any(TypeError), expect.objectContaining({ status: 503 })]);
    expect(informer.list()).toEqual([cm("a", "3")]);
  });

  it("reports watch connection failures and resumes without listing again", async () => {
    vi.useFakeTimers();
    const { server, informer, log, errors } = setup();
    server.lists.push(list("10", []));
    await informer.start();

    const first = await server.watch(0);
    first.send({ type: "ADDED", object: cm("a", "11") });
    await vi.advanceTimersByTimeAsync(0);
    first.fail(new TypeError("network error"));
    await vi.advanceTimersByTimeAsync(100);

    const second = await server.watch(1);
    expect(second.url.searchParams.get("resourceVersion")).toBe("11");
    second.send({ type: "ADDED", object: cm("b", "12") });
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([expect.any(TypeError)]);
    expect(server.listRequests).toHaveLength(1);
    expect(log).toEqual([
      ["add", "a"],
      ["add", "b"],
    ]);
  });

  it("starts over after a watch answer that reconnecting cannot change", async () => {
    vi.useFakeTimers();
    const { server, informer, errors } = setup();
    server.lists.push(list("10", []), list("20", []));
    await informer.start();
    (await server.watch(0)).send({
      type: "ERROR",
      object: { kind: "Status", code: 401, reason: "Unauthorized" },
    });
    await vi.advanceTimersByTimeAsync(100);

    const second = await server.watch(1);
    expect(second.url.searchParams.get("resourceVersion")).toBe("20");
    expect(errors).toEqual([expect.objectContaining({ status: 401 })]);
  });

  it("asks for the token again on every request", async () => {
    let issued = 0;
    const { server, informer } = setup({}, () => `token-${++issued}`);
    server.lists.push(list("10", []), list("20", []));
    await informer.start();
    const first = await server.watch(0);
    first.send({ type: "ADDED", object: cm("a", "11") });
    first.close();
    const second = await server.watch(1);

    expect(server.listRequests[0]?.headers.get("Authorization")).toBe("Bearer token-1");
    expect(first.headers.get("Authorization")).toBe("Bearer token-2");
    expect(second.headers.get("Authorization")).toBe("Bearer token-3");
  });

  it("closes the connection and goes quiet when stopped", async () => {
    const { server, informer, log } = setup();
    server.lists.push(list("10", [cm("a", "3")]));
    await informer.start();
    const watch = await server.watch(0);

    informer.stop();
    expect(watch.signal.aborted).toBe(true);
    expect(informer.hasSynced).toBe(false);
    await settle();
    expect(server.watches).toHaveLength(1);
    expect(server.listRequests).toHaveLength(1);
    // The local copy stays readable.
    expect(informer.list()).toEqual([cm("a", "3")]);
    expect(log).toEqual([["add", "a"]]);
  });

  it("rejects the start promise when stopped before the first list arrived", async () => {
    vi.useFakeTimers();
    const { server, informer } = setup();
    server.lists.push(new TypeError("Failed to fetch"));
    const started = informer.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);

    informer.stop();
    expect(await started).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.listRequests).toHaveLength(1);
  });

  it("returns the same promise while running and reports missed changes after a restart", async () => {
    const { server, informer, log } = setup();
    server.lists.push(list("10", [cm("a", "3"), cm("b", "4")]));
    const started = informer.start();
    expect(informer.start()).toBe(started);
    await started;
    informer.stop();
    log.length = 0;

    server.lists.push(list("30", [cm("a", "20")]));
    await informer.start();
    expect(log).toEqual([
      ["update", "a", "3"],
      ["delete", "b"],
    ]);
    expect(await server.watch(1)).toMatchObject({ signal: { aborted: false } });
  });

  it("stops calling a listener that was removed", async () => {
    const { server, informer } = setup();
    const names: unknown[] = [];
    const off = informer.on("add", (object) => names.push(object.metadata?.name));
    server.lists.push(list("10", [cm("a", "3")]));
    await informer.start();

    off();
    (await server.watch(0)).send({ type: "ADDED", object: cm("b", "11") });
    await settle();
    expect(names).toEqual(["a"]);
    expect(informer.get("b", "default")).toBeDefined();
  });

  it("survives a listener that throws and reports it as an error", async () => {
    const { server, informer, log, errors } = setup();
    const broken = new Error("listener bug");
    informer.on("add", () => {
      throw broken;
    });
    informer.on("error", () => {
      throw new Error("error listener bug");
    });
    server.lists.push(list("10", [cm("a", "3")]));
    await informer.start();
    (await server.watch(0)).send({ type: "ADDED", object: cm("b", "11") });
    await settle();

    expect(errors).toEqual([broken, broken]);
    expect(log).toEqual([
      ["add", "a"],
      ["add", "b"],
    ]);
  });

  it("keys cluster-scoped objects by name alone", async () => {
    const server = fakeServer();
    const informer = createClient({ baseUrl: "https://k8s.example.test", fetch: server.fetch })
      .resource(nodes)
      .informer();
    running.push(informer);
    server.lists.push(
      new Response(JSON.stringify({ metadata: {}, items: [{ metadata: { name: "node-1" } }] })),
    );
    await informer.start();

    expect(server.listRequests[0]?.url.pathname).toBe("/api/v1/nodes");
    expect(informer.get("node-1")).toEqual({ metadata: { name: "node-1" } });
  });
});
