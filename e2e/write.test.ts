import { afterEach, describe, expect, it } from "vitest";
import type { ApiError } from "../src/index.ts";
import { client, configMaps, namespace, uniqueName, widgets } from "./fixtures.ts";

const created: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  // Best-effort cleanup so a failed test does not leave objects behind.
  await Promise.all(created.splice(0).map((remove) => remove().catch(() => undefined)));
});

function track(
  resource: { delete(name: string, options: { namespace: string }): Promise<unknown> },
  name: string,
): void {
  created.push(() => resource.delete(name, { namespace }));
}

describe("writing built-in resources from the browser", () => {
  it("creates, reads, updates, patches and deletes a ConfigMap", async () => {
    const resource = client().resource(configMaps);
    const name = uniqueName("cm");
    track(resource, name);

    const createdObject = await resource.create({
      metadata: { name, namespace },
      data: { a: "1" },
    });
    expect(createdObject.metadata?.uid).toBeTruthy();

    const fetched = await resource.get(name, { namespace });
    expect(fetched.data).toEqual({ a: "1" });

    const updated = await resource.update({ ...fetched, data: { a: "2" } });
    expect(updated.data).toEqual({ a: "2" });
    expect(updated.metadata?.resourceVersion).not.toBe(fetched.metadata?.resourceVersion);

    const merged = await resource.patch(name, { data: { b: "3" } }, { namespace });
    expect(merged.data).toEqual({ a: "2", b: "3" });

    const strategic = await resource.patch(
      name,
      { data: { c: "4" } },
      { namespace, type: "strategic" },
    );
    expect(strategic.data).toEqual({ a: "2", b: "3", c: "4" });

    const jsonPatched = await resource.patch(name, [{ op: "remove", path: "/data/a" }], {
      namespace,
      type: "json",
    });
    expect(jsonPatched.data).toEqual({ b: "3", c: "4" });

    await resource.delete(name, { namespace });
    const afterDelete = await resource.get(name, { namespace }).catch((e: unknown) => e);
    expect((afterDelete as ApiError).reason).toBe("NotFound");
  });

  it("rejects creating an object that already exists", async () => {
    const resource = client().resource(configMaps);
    const name = uniqueName("cm");
    track(resource, name);

    await resource.create({ metadata: { name, namespace } });
    const error = await resource.create({ metadata: { name, namespace } }).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).reason).toBe("AlreadyExists");
  });

  it("rejects an update made from a stale resource version", async () => {
    const resource = client().resource(configMaps);
    const name = uniqueName("cm");
    track(resource, name);

    const original = await resource.create({ metadata: { name, namespace }, data: { a: "1" } });
    await resource.update({ ...original, data: { a: "2" } });
    const error = await resource.update({ ...original, data: { a: "3" } }).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).reason).toBe("Conflict");
  });

  it("does not persist a dry-run create", async () => {
    const resource = client().resource(configMaps);
    const name = uniqueName("cm");
    track(resource, name);

    await resource.create({ metadata: { name, namespace } }, { dryRun: "All" });
    const error = await resource.get(name, { namespace }).catch((e: unknown) => e);
    expect((error as ApiError).reason).toBe("NotFound");
  });

  it("creates and then updates through server-side apply", async () => {
    const resource = client().resource(configMaps);
    const name = uniqueName("cm");
    track(resource, name);
    const base = { apiVersion: "v1", kind: "ConfigMap", metadata: { name, namespace } };

    const first = await resource.apply({ ...base, data: { a: "1" } }, { fieldManager: "e2e" });
    expect(first.data).toEqual({ a: "1" });

    // Fields this manager no longer declares are removed.
    const second = await resource.apply({ ...base, data: { b: "2" } }, { fieldManager: "e2e" });
    expect(second.data).toEqual({ b: "2" });
  });

  it("honours a delete precondition", async () => {
    const resource = client().resource(configMaps);
    const name = uniqueName("cm");
    track(resource, name);

    await resource.create({ metadata: { name, namespace } });
    const error = await resource
      .delete(name, { namespace, preconditions: { uid: "00000000-0000-0000-0000-000000000000" } })
      .catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(409);
    await resource.get(name, { namespace });
  });
});

describe("custom resources from the browser", () => {
  it("creates, lists, updates the status of and deletes a custom resource", async () => {
    const resource = client().resource(widgets);
    const name = uniqueName("widget");
    track(resource, name);

    const widget = await resource.create({
      apiVersion: "e2e.kube-client-web.test/v1",
      kind: "Widget",
      metadata: { name, namespace, labels: { test: name } },
      spec: { size: 3 },
    });
    expect(widget.spec?.size).toBe(3);

    const list = await resource.list({ namespace, labelSelector: `test=${name}` });
    expect(list.items.map((item) => item.metadata?.name)).toEqual([name]);

    const withStatus = await resource.update(
      { ...widget, status: { ready: true } },
      { subresource: "status" },
    );
    expect(withStatus.status?.ready).toBe(true);

    const patched = await resource.patch(name, { spec: { size: 5 } }, { namespace });
    expect(patched.spec?.size).toBe(5);
    expect(patched.status?.ready).toBe(true);

    await resource.delete(name, { namespace });
  });
});
