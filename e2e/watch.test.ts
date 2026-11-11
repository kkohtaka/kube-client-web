import { afterEach, describe, expect, it } from "vitest";
import { ApiError, defineResource, isGone, type WatchEvent } from "../src/index.ts";
import { type ConfigMap, client, configMaps, namespace, uniqueName, widgets } from "./fixtures.ts";

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  // Best-effort cleanup so a failed test leaves neither objects nor open watches behind.
  await Promise.all(
    cleanups.splice(0).map(async (cleanup) => {
      try {
        await cleanup();
      } catch {
        // Already gone.
      }
    }),
  );
});

/** A selector that only matches objects created by the calling test. */
function isolate(): { labels: Record<string, string>; labelSelector: string } {
  const id = uniqueName("watch");
  return { labels: { "e2e-watch": id }, labelSelector: `e2e-watch=${id}` };
}

/** A signal that ends the test's watch when the test is over, however it went. */
function untilTestEnds(): AbortSignal {
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  return abort.signal;
}

function track(name: string): void {
  cleanups.push(() => client().resource(configMaps).delete(name, { namespace }));
}

/** Reads events until one matches, skipping bookmarks. */
async function until(
  events: AsyncGenerator<WatchEvent<ConfigMap>>,
  matches: (event: WatchEvent<ConfigMap>) => boolean,
): Promise<WatchEvent<ConfigMap>[]> {
  const seen: WatchEvent<ConfigMap>[] = [];
  for (;;) {
    const next = await events.next();
    if (next.done) {
      throw new Error(`the watch ended after ${JSON.stringify(seen.map((e) => e.type))}`);
    }
    if (next.value.type === "BOOKMARK") {
      continue;
    }
    seen.push(next.value);
    if (matches(next.value)) {
      return seen;
    }
  }
}

describe("watching from the browser", () => {
  it("streams changes made after a list", async () => {
    const resource = client().resource(configMaps);
    const { labels, labelSelector } = isolate();
    const name = uniqueName("cm");
    track(name);

    const list = await resource.list({ namespace, labelSelector });
    const events = resource.watch({
      namespace,
      labelSelector,
      resourceVersion: list.metadata?.resourceVersion,
      signal: untilTestEnds(),
    });
    const changes = until(events, (event) => event.type === "DELETED");

    await resource.create({ metadata: { name, namespace, labels }, data: { a: "1" } });
    await resource.patch(name, { data: { a: "2" } }, { namespace });
    await resource.delete(name, { namespace });

    const seen = await changes;
    expect(seen.map((event) => event.type)).toEqual(["ADDED", "MODIFIED", "DELETED"]);
    expect(seen.map((event) => (event.object as ConfigMap).data)).toEqual([
      { a: "1" },
      { a: "2" },
      { a: "2" },
    ]);
    expect(seen.every((event) => event.object.metadata?.name === name)).toBe(true);
  });

  it("reports existing objects as ADDED when no resource version is given", async () => {
    const resource = client().resource(configMaps);
    const { labels, labelSelector } = isolate();
    const name = uniqueName("cm");
    track(name);
    await resource.create({ metadata: { name, namespace, labels } });

    const events = resource.watch({ namespace, labelSelector, signal: untilTestEnds() });
    const seen = await until(events, () => true);
    expect(seen[0]).toMatchObject({ type: "ADDED", object: { metadata: { name } } });
  });

  it("ends when the server-side timeout expires", async () => {
    const events = client().resource(configMaps).watch({
      namespace,
      labelSelector: isolate().labelSelector,
      timeoutSeconds: 1,
      signal: untilTestEnds(),
    });

    const started = performance.now();
    for await (const event of events) {
      expect(event.type).toBe("BOOKMARK");
    }
    expect(performance.now() - started).toBeGreaterThan(500);
  });

  it("rejects with the abort reason when aborted", async () => {
    const abort = new AbortController();
    const events = client().resource(configMaps).watch({
      namespace,
      labelSelector: isolate().labelSelector,
      signal: abort.signal,
    });
    const next = until(events, () => true);
    setTimeout(() => abort.abort(new Error("stop")), 200);
    await expect(next).rejects.toThrow("stop");
  });

  it("fails with 410 Gone for a resource version that is too old", async () => {
    // The custom resource was registered long after the cluster started, so
    // the server no longer has the history back to version 1 for it. For
    // built-in resources of a fresh cluster it still does.
    const signal = untilTestEnds();
    let error: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      error = await client()
        .resource(widgets)
        .watch({ namespace, resourceVersion: "1", timeoutSeconds: 5, signal })
        .next()
        .catch((e: unknown) => e);
      // The server answers 429 while it is still loading a resource it has not served yet.
      if (!(error instanceof ApiError && error.status === 429)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(error).toMatchObject({ status: 410, reason: "Expired" });
    expect(isGone(error)).toBe(true);
  });

  it("gives up with 410 Gone instead of reconnecting forever", async () => {
    // The reconnecting watch waits out the 429 of a resource that is still loading.
    const events = client()
      .resource(widgets)
      .watchWithReconnect({
        namespace,
        resourceVersion: "1",
        timeoutSeconds: 5,
        backoff: { initialDelayMs: 100, maxDelayMs: 500 },
        signal: untilTestEnds(),
      });
    const error = await events.next().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 410, reason: "Expired" });
  });

  it("is refused without permission", async () => {
    // Outside its own namespace the test identity can view everything except Secrets.
    const secrets = defineResource({ version: "v1", resource: "secrets", namespaced: true });
    const events = client().resource(secrets).watch({ namespace: "default" });
    await expect(events.next()).rejects.toMatchObject({ status: 403, reason: "Forbidden" });
  });

  it("keeps watching across connections closed by the server", async () => {
    const resource = client().resource(configMaps);
    const { labels, labelSelector } = isolate();
    const names = [uniqueName("cm"), uniqueName("cm")];
    names.forEach(track);

    const list = await resource.list({ namespace, labelSelector });
    let reconnects = 0;
    const events = resource.watchWithReconnect({
      namespace,
      labelSelector,
      resourceVersion: list.metadata?.resourceVersion,
      timeoutSeconds: 1,
      signal: untilTestEnds(),
      backoff: { initialDelayMs: 50, maxDelayMs: 200 },
      onReconnect: () => {
        reconnects += 1;
      },
    });

    await resource.create({ metadata: { name: names[0] as string, namespace, labels } });
    const first = await until(events, () => true);
    expect(first[0]).toMatchObject({ type: "ADDED", object: { metadata: { name: names[0] } } });

    // Outlive at least one server-side timeout, then expect exactly the next change.
    const second = until(events, () => true);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await resource.create({ metadata: { name: names[1] as string, namespace, labels } });
    expect((await second)[0]).toMatchObject({
      type: "ADDED",
      object: { metadata: { name: names[1] } },
    });
    expect(reconnects).toBeGreaterThan(0);
  });
});
