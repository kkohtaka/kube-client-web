import { afterEach, describe, expect, inject, it } from "vitest";
import { commands } from "vitest/browser";
import { createClient, type ResourceClient } from "../src/index.ts";
import {
  type ConfigMap,
  client,
  configMaps,
  eventually,
  namespace,
  uniqueName,
} from "./fixtures.ts";

/**
 * What an informer does in a page the browser has put in the background.
 *
 * The browsers the tests drive never do that by themselves. Under Playwright
 * a page stays visible, and its timers keep their pace, behind another page
 * and in a minimized window alike; Chromium does not freeze such a page
 * either when asked to through the DevTools protocol. So the tests emulate
 * the two things a background page goes through that matter to the library:
 *
 * - `hide()` and `show()` make the page look hidden to scripts and announce
 *   it with `visibilitychange`. Nothing slows down. This shows what the
 *   library does when it is told that the page went away and came back.
 * - `stall()` keeps the page from running for a while by keeping its only
 *   thread busy. As in a page the browser has frozen, no timer fires and
 *   nothing that arrives from the network is delivered until it is over.
 *   Unlike a frozen page, it is not told with `freeze` and `resume` events,
 *   and it is never away for so long that the browser gives up on its
 *   connections.
 *
 * Timers that fire late but do fire, once a second or once a minute, are not
 * covered by either.
 */

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  show();
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
  const id = uniqueName("background");
  return { labels: { "e2e-background": id }, labelSelector: `e2e-background=${id}` };
}

function track(name: string): void {
  cleanups.push(() => client().resource(configMaps).delete(name, { namespace }));
}

/** Makes the page look hidden to scripts. It stays as visible as it was. */
function hide(): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Undoes `hide()`. */
function show(): void {
  if (!Object.hasOwn(document, "visibilityState")) {
    return;
  }
  // The properties of the prototype, which tell the truth, show again.
  delete (document as { visibilityState?: unknown }).visibilityState;
  delete (document as { hidden?: unknown }).hidden;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Keeps the page from running anything else for this long. */
function stall(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Nothing: being busy is the point.
  }
}

/** A client that counts its list and watch requests for ConfigMaps. */
function countingClient(): {
  resource: ResourceClient<ConfigMap>;
  requests: { list: number; watch: number };
} {
  const requests = { list: 0, watch: 0 };
  const resource = createClient({
    baseUrl: inject("apiServer"),
    token: inject("token"),
    fetch: (input, init) => {
      const url = new URL(String(input));
      if (init?.method === undefined || init.method === "GET") {
        requests[url.searchParams.get("watch") === "true" ? "watch" : "list"] += 1;
      }
      return fetch(input, init);
    },
  }).resource(configMaps);
  return { resource, requests };
}

describe("an informer in a page that looks hidden", () => {
  it("keeps reporting changes, and replaces its connection when the page returns", async () => {
    const { resource, requests } = countingClient();
    const { labels, labelSelector } = isolate();
    const [during, after] = [uniqueName("cm"), uniqueName("cm")];
    track(during);
    track(after);

    const informer = resource.informer({ namespace, labelSelector, reconnectAfterHiddenMs: 300 });
    cleanups.push(() => informer.stop());
    const errors: unknown[] = [];
    informer.on("error", (error) => errors.push(error));
    await informer.start();
    await eventually(() => requests.watch === 1, "the watch to be opened");

    hide();
    await resource.create({ metadata: { name: during, namespace, labels } });
    await eventually(
      () => informer.get(during, namespace) !== undefined,
      "the object created while the page was hidden",
    );
    expect(requests).toEqual({ list: 1, watch: 1 });

    await new Promise((resolve) => setTimeout(resolve, 400));
    show();
    await eventually(() => requests.watch === 2, "a new watch connection");

    await resource.create({ metadata: { name: after, namespace, labels } });
    await eventually(
      () => informer.get(after, namespace) !== undefined,
      "the object created after the page returned",
    );
    // The new connection resumed where the old one was: nothing was listed
    // again, and replacing a connection is not an error.
    expect(requests).toEqual({ list: 1, watch: 2 });
    expect(errors).toEqual([]);
  });

  it("keeps its connection when the page was hidden only briefly", async () => {
    const { resource, requests } = countingClient();
    const { labels, labelSelector } = isolate();
    const name = uniqueName("cm");
    track(name);

    // Ten seconds by default.
    const informer = resource.informer({ namespace, labelSelector });
    cleanups.push(() => informer.stop());
    await informer.start();
    await eventually(() => requests.watch === 1, "the watch to be opened");

    hide();
    await new Promise((resolve) => setTimeout(resolve, 400));
    show();
    await resource.create({ metadata: { name, namespace, labels } });
    await eventually(() => informer.get(name, namespace) !== undefined, "the object to appear");
    expect(requests).toEqual({ list: 1, watch: 1 });
  });
});

describe("an informer in a page that does not run for a while", () => {
  it("reports the changes made meanwhile once the page runs again", async () => {
    const resource = client().resource(configMaps);
    const { labels, labelSelector } = isolate();
    const name = uniqueName("cm");
    track(name);

    const informer = resource.informer({ namespace, labelSelector });
    cleanups.push(() => informer.stop());
    const errors: unknown[] = [];
    informer.on("error", (error) => errors.push(error));
    await informer.start();

    // The page cannot make the change itself while it does not run.
    const created = await commands.createConfigMapsLater([
      { afterMs: 500, namespace, name, labels },
    ]);
    stall(2000);
    expect(informer.get(name, namespace)).toBeUndefined();
    await commands.createdLater(created);

    await eventually(
      () => informer.get(name, namespace) !== undefined,
      "the object created while the page did not run",
    );
    expect(errors).toEqual([]);
  });

  it("recovers by itself after a pause that is longer than a watch lasts", {
    timeout: 90_000,
  }, async () => {
    const { resource, requests } = countingClient();
    const { labels, labelSelector } = isolate();
    const [early, late] = [uniqueName("cm"), uniqueName("cm")];
    track(early);
    track(late);

    const informer = resource.informer({
      namespace,
      labelSelector,
      // The server ends each watch after a second, so the one that is open
      // when the page stops running is long over when it runs again.
      watchTimeoutSeconds: 1,
    });
    cleanups.push(() => informer.stop());
    const errors: unknown[] = [];
    informer.on("error", (error) => errors.push(error));
    await informer.start();
    await eventually(() => requests.watch >= 1, "the watch to be opened");

    const created = await commands.createConfigMapsLater([
      { afterMs: 300, namespace, name: early, labels },
      // By now the server has ended the watch, and nothing has replaced it.
      { afterMs: 2500, namespace, name: late, labels },
    ]);
    const before = requests.watch;
    stall(4000);
    // Nothing happened in the page: there was no new connection.
    expect(requests.watch).toBe(before);
    await commands.createdLater(created);

    // At the latest, a watch that hangs is given up 30 seconds after it was
    // due to end.
    await eventually(
      () =>
        informer.get(early, namespace) !== undefined && informer.get(late, namespace) !== undefined,
      "the objects created while the page did not run",
      60_000,
    );
    expect(requests.watch).toBeGreaterThan(before);
    expect(errors).toEqual([]);
  });
});
