import { afterEach, describe, expect, it } from "vitest";
import {
  type ConfigMap,
  client,
  configMaps,
  eventually,
  namespace,
  uniqueName,
} from "./fixtures.ts";

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  // Best-effort cleanup so a failed test leaves neither objects nor running informers behind.
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

/** Labels and a selector that only match objects created by the calling test. */
function isolate(): { labels: Record<string, string>; labelSelector: string } {
  const id = uniqueName("informer");
  return { labels: { "e2e-informer": id }, labelSelector: `e2e-informer=${id}` };
}

function track(name: string): void {
  cleanups.push(() => client().resource(configMaps).delete(name, { namespace }));
}

describe("informers in the browser", () => {
  it("loads existing objects, then follows changes", async () => {
    const resource = client().resource(configMaps);
    const { labels, labelSelector } = isolate();
    const [existing, later] = [uniqueName("cm"), uniqueName("cm")];
    track(existing);
    track(later);
    await resource.create({ metadata: { name: existing, namespace, labels }, data: { a: "1" } });
    // Not selected, so the informer must never see it.
    const other = uniqueName("cm");
    track(other);
    await resource.create({ metadata: { name: other, namespace } });

    const informer = resource.informer({ namespace, labelSelector });
    cleanups.push(() => informer.stop());
    const log: string[] = [];
    const errors: unknown[] = [];
    informer.on("add", (object) => log.push(`add ${object.metadata?.name}`));
    informer.on("update", (object, previous) =>
      log.push(`update ${object.metadata?.name} ${previous.data?.a}->${object.data?.a}`),
    );
    informer.on("delete", (object) => log.push(`delete ${object.metadata?.name}`));
    informer.on("error", (error) => errors.push(error));

    await informer.start();
    expect(informer.hasSynced).toBe(true);
    expect(log).toEqual([`add ${existing}`]);
    expect(informer.get(existing, namespace)?.data).toEqual({ a: "1" });

    await resource.create({ metadata: { name: later, namespace, labels }, data: { a: "1" } });
    await resource.patch(later, { data: { a: "2" } }, { namespace });
    await resource.delete(existing, { namespace });
    await eventually(() => log.length >= 4, "the three changes");

    expect(log).toEqual([
      `add ${existing}`,
      `add ${later}`,
      `update ${later} 1->2`,
      `delete ${existing}`,
    ]);
    expect(informer.list().map((object: ConfigMap) => object.metadata?.name)).toEqual([later]);
    expect(informer.get(later, namespace)?.data).toEqual({ a: "2" });
    expect(errors).toEqual([]);
  });

  it("keeps following across watch connections closed by the server", async () => {
    const resource = client().resource(configMaps);
    const { labels, labelSelector } = isolate();
    const name = uniqueName("cm");
    track(name);

    const informer = resource.informer({ namespace, labelSelector, watchTimeoutSeconds: 1 });
    cleanups.push(() => informer.stop());
    const errors: unknown[] = [];
    informer.on("error", (error) => errors.push(error));
    await informer.start();
    expect(informer.list()).toEqual([]);

    // Outlive at least two server-side timeouts.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await resource.create({ metadata: { name, namespace, labels } });
    await eventually(() => informer.get(name, namespace) !== undefined, "the object to appear");
    expect(errors).toEqual([]);
  });

  it("reports what changed while it was stopped", async () => {
    const resource = client().resource(configMaps);
    const { labels, labelSelector } = isolate();
    const [kept, removed, created] = [uniqueName("cm"), uniqueName("cm"), uniqueName("cm")];
    [kept, removed, created].forEach(track);
    await resource.create({ metadata: { name: kept, namespace, labels }, data: { a: "1" } });
    await resource.create({ metadata: { name: removed, namespace, labels } });

    const informer = resource.informer({ namespace, labelSelector });
    cleanups.push(() => informer.stop());
    const log: string[] = [];
    informer.on("add", (object) => log.push(`add ${object.metadata?.name}`));
    informer.on("update", (object) => log.push(`update ${object.metadata?.name}`));
    informer.on("delete", (object) => log.push(`delete ${object.metadata?.name}`));
    await informer.start();
    informer.stop();
    log.length = 0;

    await resource.patch(kept, { data: { a: "2" } }, { namespace });
    await resource.delete(removed, { namespace });
    await resource.create({ metadata: { name: created, namespace, labels } });

    await informer.start();
    expect([...log].sort()).toEqual(
      [`update ${kept}`, `delete ${removed}`, `add ${created}`].sort(),
    );
  });

  it("reports an error and keeps trying when it is not allowed to list", async () => {
    // Outside its own namespace the test identity can view everything except Secrets.
    const informer = client()
      .resource({ version: "v1", resource: "secrets", namespaced: true })
      .informer({ namespace: "default", backoff: { initialDelayMs: 50, maxDelayMs: 100 } });
    cleanups.push(() => informer.stop());
    const errors: unknown[] = [];
    informer.on("error", (error) => errors.push(error));
    const started = informer.start().catch((error: unknown) => error);

    await eventually(() => errors.length >= 2, "two failed attempts");
    expect(errors[0]).toMatchObject({ status: 403, reason: "Forbidden" });
    expect(informer.hasSynced).toBe(false);

    informer.stop();
    expect(await started).toMatchObject({ name: "AbortError" });
  });
});
