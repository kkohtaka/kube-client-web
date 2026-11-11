import { afterEach, describe, expect, it } from "vitest";
import { client, configMaps, eventually, namespace, uniqueName } from "./fixtures.ts";

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
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

describe("many watches at once", () => {
  // Browsers open at most six HTTP/1.1 connections per host, and every watch
  // holds one for as long as it runs. This only works because the API server
  // speaks HTTP/2, where all requests share one connection.
  it("runs far more informers than the HTTP/1.1 connection limit allows", async () => {
    const resource = client().resource(configMaps);
    const run = uniqueName("many");
    const count = 30;

    const informers = Array.from({ length: count }, (_, index) => {
      const informer = resource.informer({
        namespace,
        labelSelector: `e2e-many=${run},e2e-index=i${index}`,
      });
      cleanups.push(() => informer.stop());
      return informer;
    });
    await Promise.all(informers.map((informer) => informer.start()));

    // Ordinary requests still get through while all the watches are open.
    const names = informers.map((_, index) => `${run}-${index}`);
    cleanups.push(() =>
      Promise.all(names.map((name) => resource.delete(name, { namespace }).catch(() => undefined))),
    );
    await Promise.all(
      names.map((name, index) =>
        resource.create({
          metadata: { name, namespace, labels: { "e2e-many": run, "e2e-index": `i${index}` } },
        }),
      ),
    );

    await eventually(
      () => informers.every((informer) => informer.list().length === 1),
      "every informer to see its object",
    );
    informers.forEach((informer, index) => {
      expect(informer.list().map((object) => object.metadata?.name)).toEqual([names[index]]);
    });
  });
});
