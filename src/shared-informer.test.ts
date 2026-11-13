import { afterEach, describe, expect, it } from "vitest";
import { fakeServer } from "./fake-server.ts";
import {
  createClient,
  defineResource,
  type SharedInformer,
  type SharedInformerFactory,
  type SharedInformerFactoryOptions,
} from "./index.ts";
import type { KubeObject } from "./types.ts";

interface ConfigMap extends KubeObject {
  data?: Record<string, string>;
}

const configMaps = defineResource<ConfigMap>({
  version: "v1",
  resource: "configmaps",
  namespaced: true,
});
const secrets = defineResource({ version: "v1", resource: "secrets", namespaced: true });

function cm(name: string, resourceVersion: string): ConfigMap {
  return { metadata: { name, namespace: "default", resourceVersion } };
}

function list(resourceVersion: string, items: ConfigMap[]): Response {
  return new Response(JSON.stringify({ metadata: { resourceVersion }, items }), { status: 200 });
}

function event(type: string, object: ConfigMap): unknown {
  return { type, object };
}

const factories: SharedInformerFactory[] = [];

afterEach(() => {
  for (const factory of factories.splice(0)) {
    factory.stop();
  }
});

function setup(options: SharedInformerFactoryOptions = {}): {
  server: ReturnType<typeof fakeServer>;
  factory: SharedInformerFactory;
} {
  const server = fakeServer();
  const factory = createClient({
    baseUrl: "https://k8s.example.test",
    token: "abc",
    fetch: server.fetch,
  }).sharedInformers({ backoff: { initialDelayMs: 100, maxDelayMs: 400, jitter: 0 }, ...options });
  factories.push(factory);
  return { server, factory };
}

/** Records what an informer reports, as `[event, name, ...]`. */
function record(informer: SharedInformer<ConfigMap>): { log: unknown[][]; errors: unknown[] } {
  const log: unknown[][] = [];
  const errors: unknown[] = [];
  informer.on("add", (object) => log.push(["add", object.metadata?.name]));
  informer.on("update", (object, previous) =>
    log.push(["update", object.metadata?.name, previous.metadata?.resourceVersion]),
  );
  informer.on("delete", (object) => log.push(["delete", object.metadata?.name]));
  informer.on("error", (error) => errors.push(error));
  return { log, errors };
}

/** Lets everything that is ready to run do so. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SharedInformerFactory", () => {
  it("serves informers for the same objects with one list and one watch", async () => {
    const { server, factory } = setup();
    server.lists.push(list("10", [cm("a", "3"), cm("b", "7")]));
    const first = factory.informer(configMaps, { namespace: "default" });
    const second = factory.informer(configMaps, { namespace: "default" });
    const one = record(first);
    const two = record(second);

    await Promise.all([first.start(), second.start()]);

    const added = [
      ["add", "a"],
      ["add", "b"],
    ];
    expect(one.log).toEqual(added);
    expect(two.log).toEqual(added);
    expect(first.hasSynced).toBe(true);
    expect(second.list()).toEqual([cm("a", "3"), cm("b", "7")]);
    expect(second.get("a", "default")).toEqual(cm("a", "3"));

    const watch = await server.watch(0);
    watch.send(event("MODIFIED", cm("a", "11")), event("DELETED", cm("b", "12")));
    await settle();

    const changed = [...added, ["update", "a", "3"], ["delete", "b"]];
    expect(one.log).toEqual(changed);
    expect(two.log).toEqual(changed);
    expect(server.listRequests).toHaveLength(1);
    expect(server.watches).toHaveLength(1);
  });

  it("passes its options and the selection on to the requests", async () => {
    const { server, factory } = setup({ pageSize: 20, watchTimeoutSeconds: 123 });
    server.lists.push(list("10", []));
    const informer = factory.informer(configMaps, {
      namespace: "default",
      labelSelector: "app=web",
      fieldSelector: "a=b",
    });

    await informer.start();

    const request = server.listRequests[0]?.url;
    expect(request?.pathname).toBe("/api/v1/namespaces/default/configmaps");
    expect(Object.fromEntries(request?.searchParams ?? [])).toEqual({
      labelSelector: "app=web",
      fieldSelector: "a=b",
      limit: "20",
    });
    const watch = await server.watch(0);
    expect(Object.fromEntries(watch.url.searchParams)).toMatchObject({
      labelSelector: "app=web",
      fieldSelector: "a=b",
      timeoutSeconds: "123",
    });
  });

  it("keeps informers apart that differ in resource, namespace or selector", async () => {
    const { server, factory } = setup();
    const informers = [
      factory.informer(configMaps, { namespace: "default" }),
      factory.informer(configMaps, { namespace: "other" }),
      factory.informer(configMaps),
      factory.informer(configMaps, { namespace: "default", labelSelector: "app=web" }),
      factory.informer(configMaps, { namespace: "default", fieldSelector: "a=b" }),
      factory.informer(secrets, { namespace: "default" }),
    ];
    for (const _ of informers) {
      server.lists.push(list("10", []));
    }

    await Promise.all(informers.map((informer) => informer.start()));
    await server.watch(informers.length - 1);

    expect(server.listRequests).toHaveLength(informers.length);
    expect(new Set(server.listRequests.map(({ url }) => url.href)).size).toBe(informers.length);
    expect(server.watches).toHaveLength(informers.length);
  });

  it("treats an empty selector like a missing one", async () => {
    const { server, factory } = setup();
    server.lists.push(list("10", []));
    const first = factory.informer(configMaps, { namespace: "default" });
    const second = factory.informer(configMaps, {
      namespace: "default",
      labelSelector: "",
      fieldSelector: "",
    });

    await Promise.all([first.start(), second.start()]);

    expect(server.listRequests).toHaveLength(1);
    expect([...(server.listRequests[0]?.url.searchParams.keys() ?? [])]).toEqual(["limit"]);
  });

  it("reports the objects already known to an informer that starts later", async () => {
    const { server, factory } = setup();
    server.lists.push(list("10", [cm("a", "3"), cm("b", "7")]));
    const first = factory.informer(configMaps, { namespace: "default" });
    await first.start();
    const watch = await server.watch(0);
    watch.send(event("ADDED", cm("c", "11")), event("DELETED", cm("a", "12")));
    await settle();

    const second = factory.informer(configMaps, { namespace: "default" });
    const { log } = record(second);
    expect(second.hasSynced).toBe(false);
    await second.start();

    expect(second.hasSynced).toBe(true);
    expect(log).toEqual([
      ["add", "b"],
      ["add", "c"],
    ]);
    expect(server.listRequests).toHaveLength(1);

    watch.send(event("MODIFIED", cm("b", "13")));
    await settle();
    expect(log.at(-1)).toEqual(["update", "b", "7"]);
  });

  it("reports each object once to an informer started while a list is being reported", async () => {
    const { server, factory } = setup();
    server.lists.push(list("10", [cm("a", "3"), cm("b", "7"), cm("c", "9")]));
    const first = factory.informer(configMaps, { namespace: "default" });
    const second = factory.informer(configMaps, { namespace: "default" });
    const { log } = record(second);
    first.on("add", (object) => {
      if (object.metadata?.name === "a") {
        void second.start();
      }
    });

    await first.start();
    await settle();

    expect(log).toEqual([
      ["add", "a"],
      ["add", "b"],
      ["add", "c"],
    ]);
  });

  it("keeps the connection until the last informer stops", async () => {
    const { server, factory } = setup();
    server.lists.push(list("10", [cm("a", "3")]));
    const first = factory.informer(configMaps, { namespace: "default" });
    const second = factory.informer(configMaps, { namespace: "default" });
    const one = record(first);
    const two = record(second);
    await Promise.all([first.start(), second.start()]);
    const watch = await server.watch(0);

    first.stop();
    watch.send(event("MODIFIED", cm("a", "11")));
    await settle();

    expect(watch.signal.aborted).toBe(false);
    expect(first.hasSynced).toBe(false);
    expect(one.log).toEqual([["add", "a"]]);
    expect(two.log).toEqual([
      ["add", "a"],
      ["update", "a", "3"],
    ]);
    // Still readable, and still current while someone else keeps it so.
    expect(first.get("a", "default")).toEqual(cm("a", "11"));

    second.stop();
    expect(watch.signal.aborted).toBe(true);
    expect(second.list()).toEqual([cm("a", "11")]);
  });

  it("lists afresh for an informer that starts after the connection was closed", async () => {
    const { server, factory } = setup();
    server.lists.push(list("10", [cm("a", "3"), cm("b", "7")]));
    const informer = factory.informer(configMaps, { namespace: "default" });
    const { log } = record(informer);
    await informer.start();
    await server.watch(0);
    informer.stop();

    server.lists.push(list("20", [cm("b", "7"), cm("c", "15")]));
    await informer.start();

    // Everything is new to an informer that was not following.
    expect(log.slice(2)).toEqual([
      ["add", "b"],
      ["add", "c"],
    ]);
    expect(informer.list()).toEqual([cm("b", "7"), cm("c", "15")]);
    expect(server.listRequests).toHaveLength(2);
  });

  it("reports every object again to an informer that restarts while others go on", async () => {
    const { server, factory } = setup();
    server.lists.push(list("10", [cm("a", "3")]));
    const first = factory.informer(configMaps, { namespace: "default" });
    const second = factory.informer(configMaps, { namespace: "default" });
    const { log } = record(first);
    await Promise.all([first.start(), second.start()]);

    first.stop();
    await first.start();

    expect(log).toEqual([
      ["add", "a"],
      ["add", "a"],
    ]);
    expect(server.listRequests).toHaveLength(1);
  });

  it("returns the same promise from start() while started", async () => {
    const { server, factory } = setup();
    server.lists.push(list("10", []));
    const informer = factory.informer(configMaps, { namespace: "default" });

    const synced = informer.start();
    expect(informer.start()).toBe(synced);
    await synced;
    expect(informer.start()).toBe(synced);
  });

  it("rejects start() for an informer stopped before the first list, and only for that one", async () => {
    const { server, factory } = setup();
    // The first list fails, so both are still waiting when one of them stops.
    server.lists.push(new TypeError("Failed to fetch"));
    const first = factory.informer(configMaps, { namespace: "default" });
    const second = factory.informer(configMaps, { namespace: "default" });
    const { log } = record(first);

    const firstSynced = first.start();
    const secondSynced = second.start();
    await settle();
    first.stop();
    await expect(firstSynced).rejects.toMatchObject({ name: "AbortError" });

    server.lists.push(list("10", [cm("a", "3")]));
    await secondSynced;
    expect(second.hasSynced).toBe(true);
    expect(log).toEqual([]);
  });

  it("reports errors to every informer and keeps going", async () => {
    const { server, factory } = setup();
    server.lists.push(new TypeError("Failed to fetch"), list("10", [cm("a", "3")]));
    const first = factory.informer(configMaps, { namespace: "default" });
    const second = factory.informer(configMaps, { namespace: "default" });
    const one = record(first);
    const two = record(second);

    await Promise.all([first.start(), second.start()]);

    expect(one.errors).toHaveLength(1);
    expect(two.errors).toEqual(one.errors);
    expect(two.log).toEqual([["add", "a"]]);
  });

  it("keeps a throwing listener from disturbing other informers", async () => {
    const { server, factory } = setup();
    server.lists.push(list("10", [cm("a", "3")]));
    const first = factory.informer(configMaps, { namespace: "default" });
    const second = factory.informer(configMaps, { namespace: "default" });
    const failure = new Error("listener failed");
    first.on("add", () => {
      throw failure;
    });
    const one = record(first);
    const two = record(second);

    await Promise.all([first.start(), second.start()]);

    expect(one.errors).toEqual([failure]);
    expect(two.errors).toEqual([]);
    expect(two.log).toEqual([["add", "a"]]);
  });

  it("stops listeners that were removed", async () => {
    const { server, factory } = setup();
    server.lists.push(list("10", [cm("a", "3")]));
    const informer = factory.informer(configMaps, { namespace: "default" });
    const names: unknown[] = [];
    const off = informer.on("add", (object) => names.push(object.metadata?.name));
    await informer.start();
    off();

    (await server.watch(0)).send(event("ADDED", cm("b", "11")));
    await settle();

    expect(names).toEqual(["a"]);
  });

  it("has nothing to read before it is started", () => {
    const { factory } = setup();
    const informer = factory.informer(configMaps, { namespace: "default" });

    expect(informer.hasSynced).toBe(false);
    expect(informer.list()).toEqual([]);
    expect(informer.get("a", "default")).toBeUndefined();
    informer.stop();
  });

  it("stops every informer with the factory, and can be used again", async () => {
    const { server, factory } = setup();
    server.lists.push(list("10", [cm("a", "3")]), list("10", []));
    const first = factory.informer(configMaps, { namespace: "default" });
    const second = factory.informer(configMaps, { namespace: "default" });
    const third = factory.informer(secrets, { namespace: "default" });
    await Promise.all([first.start(), second.start(), third.start()]);
    await server.watch(1);

    factory.stop();

    expect([first.hasSynced, second.hasSynced, third.hasSynced]).toEqual([false, false, false]);
    expect(server.watches.map((watch) => watch.signal.aborted)).toEqual([true, true]);

    server.lists.push(list("20", [cm("a", "3")]));
    await first.start();
    expect(first.hasSynced).toBe(true);
  });
});
