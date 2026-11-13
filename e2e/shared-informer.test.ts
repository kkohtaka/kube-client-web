import { afterEach, describe, expect, inject, it } from "vitest";
import { createClient } from "../src/index.ts";
import { client, configMaps, eventually, namespace, uniqueName } from "./fixtures.ts";

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

describe("shared informers in the browser", () => {
  it("serves several informers over one connection, until the last one stops", async () => {
    const resource = client().resource(configMaps);
    const id = uniqueName("shared");
    const labels = { "e2e-shared-informer": id };
    const labelSelector = `e2e-shared-informer=${id}`;
    const [existing, later, last] = [uniqueName("cm"), uniqueName("cm"), uniqueName("cm")];
    for (const name of [existing, later, last]) {
      cleanups.push(() => resource.delete(name, { namespace }));
    }
    await resource.create({ metadata: { name: existing, namespace, labels } });

    // Counts what the informers send, apart from the requests of the test itself.
    const requests: { watch: boolean; signal: AbortSignal | null | undefined }[] = [];
    const factory = createClient({
      baseUrl: inject("apiServer"),
      token: inject("token"),
      fetch: (input, init) => {
        requests.push({ watch: String(input).includes("watch=true"), signal: init?.signal });
        return fetch(input, init);
      },
    }).sharedInformers();
    cleanups.push(() => factory.stop());

    const logs: string[][] = [[], [], []];
    const informers = logs.map((log) => {
      const informer = factory.informer(configMaps, { namespace, labelSelector });
      informer.on("add", (object) => log.push(`add ${object.metadata?.name}`));
      informer.on("delete", (object) => log.push(`delete ${object.metadata?.name}`));
      return informer;
    });
    const [first, second, third] = informers as [
      (typeof informers)[number],
      (typeof informers)[number],
      (typeof informers)[number],
    ];

    await Promise.all([first.start(), second.start()]);
    expect(logs[0]).toEqual([`add ${existing}`]);
    expect(logs[1]).toEqual([`add ${existing}`]);

    await resource.create({ metadata: { name: later, namespace, labels } });
    await eventually(() => logs[0]?.length === 2 && logs[1]?.length === 2, "the new object");

    // A latecomer learns what the others know without asking the server.
    await third.start();
    expect([...(logs[2] ?? [])].sort()).toEqual([`add ${existing}`, `add ${later}`].sort());

    first.stop();
    second.stop();
    await resource.delete(existing, { namespace });
    await eventually(() => logs[2]?.includes(`delete ${existing}`) ?? false, "the deletion");
    expect(logs[0]).toHaveLength(2);
    expect(third.list().map((object) => object.metadata?.name)).toEqual([later]);

    expect(requests.filter((request) => !request.watch)).toHaveLength(1);
    const watches = requests.filter((request) => request.watch);
    expect(watches).toHaveLength(1);
    expect(watches[0]?.signal?.aborted).toBe(false);

    third.stop();
    expect(watches[0]?.signal?.aborted).toBe(true);
  });
});
