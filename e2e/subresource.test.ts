import { afterEach, describe, expect, it } from "vitest";
import type { ApiError } from "../src/index.ts";
import {
  client,
  deployments,
  namespace,
  pods,
  shell,
  uniqueName,
  type Widget,
  widgets,
} from "./fixtures.ts";

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  // Best-effort cleanup so a failed test leaves nothing behind.
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

/** Creates a pod that runs the script and resolves once its container has started. */
async function run(script: string): Promise<string> {
  const resource = client().resource(pods);
  const name = uniqueName("log");
  cleanups.push(() => resource.delete(name, { namespace, gracePeriodSeconds: 0 }));
  await resource.create({ metadata: { name, namespace }, spec: shell(script) });

  // The log cannot be read before the container exists; the API server says
  // so with a BadRequest.
  const deadline = performance.now() + 60_000;
  for (;;) {
    try {
      await resource.log(name, { namespace, limitBytes: 1 });
      return name;
    } catch (error) {
      if ((error as ApiError).status !== 400 || performance.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** A script that writes "line 0", "line 1" and so on, five times a second, without end. */
const counting = 'i=0; while :; do echo "line $i"; i=$((i+1)); read -t 0.2; done';

describe("pod logs in the browser", () => {
  it("reads the log of a container that has finished", async () => {
    const resource = client().resource(pods);
    const name = await run('echo one; echo two; printf three; read -t 1; echo; echo "four ✓"');
    // Wait for the end: following returns when the container stops.
    for await (const _ of resource.followLog(name, { namespace })) {
      // Nothing to do with the lines here.
    }

    expect(await resource.log(name, { namespace })).toBe("one\ntwo\nthree\nfour ✓\n");
    expect(await resource.log(name, { namespace, tailLines: 1 })).toBe("four ✓\n");
    expect(await resource.log(name, { namespace, container: "main", limitBytes: 5 })).toBe(
      "one\nt",
    );
    const stamped = await resource.log(name, { namespace, timestamps: true, tailLines: 1 });
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z four ✓\n$/);
  });

  it("follows a log line by line until the container stops", async () => {
    const resource = client().resource(pods);
    const name = await run('for i in 1 2 3 4 5; do echo "line $i"; read -t 0.3; done');

    const lines: string[] = [];
    for await (const line of resource.followLog(name, { namespace })) {
      lines.push(line);
    }

    expect(lines).toEqual(["line 1", "line 2", "line 3", "line 4", "line 5"]);
  });

  it("follows a log that keeps growing, until the caller stops", async () => {
    const resource = client().resource(pods);
    const name = await run(counting);

    // Leaving the loop closes the connection.
    const lines: string[] = [];
    for await (const line of resource.followLog(name, { namespace })) {
      lines.push(line);
      if (lines.length === 8) {
        break;
      }
    }
    expect(lines).toEqual(Array.from({ length: 8 }, (_, i) => `line ${i}`));

    // Aborting ends a wait for the next line with the caller's reason.
    const abort = new AbortController();
    const reason = new Error("enough");
    const seen: string[] = [];
    const following = (async () => {
      for await (const line of resource.followLog(name, {
        namespace,
        tailLines: 1,
        signal: abort.signal,
      })) {
        seen.push(line);
        if (seen.length === 2) {
          abort.abort(reason);
        }
      }
    })();
    await expect(following).rejects.toBe(reason);
    expect(seen).toHaveLength(2);
  });

  it("reports a pod that does not exist", async () => {
    const resource = client().resource(pods);
    const missing = uniqueName("missing");

    const read = await resource.log(missing, { namespace }).catch((e: unknown) => e);
    expect(read).toMatchObject({ status: 404, reason: "NotFound" });

    const lines = resource.followLog(missing, { namespace });
    const followed = await lines.next().catch((e: unknown) => e);
    expect(followed).toMatchObject({ status: 404, reason: "NotFound" });
  });
});

describe("scale in the browser", () => {
  it("reads and sets the replicas of a deployment", async () => {
    const resource = client().resource(deployments);
    const name = uniqueName("scale");
    const labels = { app: name };
    cleanups.push(() => resource.delete(name, { namespace, propagationPolicy: "Background" }));
    await resource.create({
      metadata: { name, namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: { ...shell("while :; do read -t 60; done"), restartPolicy: "Always" },
        },
      },
    });

    const before = await resource.getScale(name, { namespace });
    expect(before.kind).toBe("Scale");
    expect(before.spec?.replicas).toBe(1);

    const scaled = await resource.scale(name, 3, { namespace });
    expect(scaled.spec?.replicas).toBe(3);
    expect((await resource.get(name, { namespace })).spec?.replicas).toBe(3);

    // A dry run answers as if, and changes nothing.
    const dry = await resource.scale(name, 0, { namespace, dryRun: "All" });
    expect(dry.spec?.replicas).toBe(0);
    expect((await resource.getScale(name, { namespace })).spec?.replicas).toBe(3);
  });
});

describe("other subresources in the browser", () => {
  it("reads and replaces the status of a custom resource", async () => {
    const resource = client().resource(widgets);
    const name = uniqueName("widget");
    cleanups.push(() => resource.delete(name, { namespace }));
    await resource.create({
      apiVersion: "e2e.kube-client-web.test/v1",
      kind: "Widget",
      metadata: { name, namespace },
      spec: { size: 1 },
    });

    const status = resource.subresource<Widget>(name, "status", { namespace });
    const current = await status.get();
    expect(current.status).toBeUndefined();

    const updated = await status.update({ ...current, status: { ready: true } });
    expect(updated.status).toEqual({ ready: true });
    expect((await status.patch({ status: { ready: false } })).status).toEqual({ ready: false });
  });
});
