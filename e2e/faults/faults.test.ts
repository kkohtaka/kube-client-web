import { afterEach, describe, expect, inject, it } from "vitest";
import { commands } from "vitest/browser";
import { ApiError, createClient } from "../../src/index.ts";
import {
  client,
  configMaps,
  eventually,
  hidesUnauthenticatedAnswers,
  namespace,
  uniqueName,
} from "../fixtures.ts";

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

/** Labels and a selector that only match objects created by the calling test. */
function isolate(): { labels: Record<string, string>; labelSelector: string } {
  const id = uniqueName("fault");
  return { labels: { "e2e-fault": id }, labelSelector: `e2e-fault=${id}` };
}

/** Repeats a request until the API server accepts it. */
async function persistently<R>(request: () => Promise<R>): Promise<R> {
  const deadline = performance.now() + 60_000;
  for (;;) {
    try {
      return await request();
    } catch (error) {
      if (performance.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

describe("an informer", () => {
  it("recovers when the API server restarts", { timeout: 240_000 }, async () => {
    const resource = client().resource(configMaps);
    const { labels, labelSelector } = isolate();
    const [before, after] = [uniqueName("cm"), uniqueName("cm")];
    cleanups.push(() => resource.delete(before, { namespace }));
    cleanups.push(() => resource.delete(after, { namespace }));

    const informer = resource.informer({
      namespace,
      labelSelector,
      // Chromium and Firefox fail the open watch as soon as the server goes
      // away. WebKit leaves it hanging, and the informer only finds out when
      // the server does not end the watch on time, 30 seconds after this.
      watchTimeoutSeconds: 5,
      backoff: { initialDelayMs: 200, maxDelayMs: 2000 },
    });
    cleanups.push(() => informer.stop());
    const errors: unknown[] = [];
    informer.on("error", (error) => errors.push(error));
    await informer.start();

    await resource.create({ metadata: { name: before, namespace, labels } });
    await eventually(() => informer.get(before, namespace) !== undefined, "the first object");

    await commands.restartApiServer();

    await persistently(() => resource.create({ metadata: { name: after, namespace, labels } }));
    await eventually(
      () => informer.get(after, namespace) !== undefined,
      "the object created after the restart",
      90_000,
    );
    // The outage was reported, and nothing was lost over it.
    expect(errors.length).toBeGreaterThan(0);
    expect(
      informer
        .list()
        .map((object) => object.metadata?.name)
        .sort(),
    ).toEqual([before, after].sort());
  });

  it("carries on with a new token after the old one stops working", {
    timeout: 120_000,
  }, async () => {
    const admin = client().resource(configMaps);
    const { labels, labelSelector } = isolate();
    const name = uniqueName("cm");
    cleanups.push(() => admin.delete(name, { namespace }));

    const first = await commands.createRevocableToken();
    cleanups.push(() => commands.revokeToken(first.secret));
    let token = first.token;
    const informer = createClient({ baseUrl: inject("apiServer"), token: () => token })
      .resource(configMaps)
      .informer({
        namespace,
        labelSelector,
        // Short-lived connections, so the informer soon needs the token again.
        watchTimeoutSeconds: 1,
        backoff: { initialDelayMs: 100, maxDelayMs: 500 },
      });
    cleanups.push(() => informer.stop());
    const errors: unknown[] = [];
    informer.on("error", (error) => errors.push(error));
    await informer.start();

    // The API server remembers a valid token for a few seconds.
    await commands.revokeToken(first.secret);
    await eventually(
      () =>
        errors.some((error) =>
          hidesUnauthenticatedAnswers
            ? error instanceof TypeError
            : error instanceof ApiError && error.status === 401,
        ),
      "the informer to be turned away",
      60_000,
    );

    // A change it cannot see for now.
    await admin.create({ metadata: { name, namespace, labels } });
    expect(informer.get(name, namespace)).toBeUndefined();

    const second = await commands.createRevocableToken();
    cleanups.push(() => commands.revokeToken(second.secret));
    token = second.token;
    await eventually(
      () => informer.get(name, namespace) !== undefined,
      "the missed object",
      30_000,
    );
  });
});
