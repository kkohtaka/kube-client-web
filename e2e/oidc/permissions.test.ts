import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kubectl, kubectlWith } from "../kubectl.ts";

/**
 * What the user who signs in may change outside the namespace of the e2e
 * tests, which is what examples/demo needs. The role for it in ../rbac.yaml
 * covers the whole cluster; the admission policy next to it narrows that to
 * what the demo made.
 *
 * The requests are made as that user by impersonation, and as dry runs: the
 * API server decides as it would otherwise, but a request that is wrongly
 * allowed changes nothing.
 */

const user = "oidc:jane@example.com";
const demo = { "app.kubernetes.io/managed-by": "kube-client-web-demo" };
const restricted = { "pod-security.kubernetes.io/enforce": "restricted" };
const id = Math.random().toString(36).slice(2, 7);
/** A namespace as the demo makes them, and one that is not the demo's. */
const own = `demo-permissions-${id}`;
const foreign = `permissions-${id}`;

function asUser(...args: string[]): Promise<string> {
  return kubectl("--as", user, "--dry-run=server", ...args);
}

function createAsUser(manifest: object): Promise<string> {
  return kubectlWith(manifest, "--as", user, "--dry-run=server", "create", "-f", "-");
}

function namespace(name: string, labels: Record<string, string>) {
  return { apiVersion: "v1", kind: "Namespace", metadata: { name, labels } };
}

function deployment(name: string, namespace: string, labels: Record<string, string>) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels },
    spec: {
      replicas: 0,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: { containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }] },
      },
    },
  };
}

beforeAll(async () => {
  await kubectlWith(namespace(own, { ...demo, ...restricted }), "create", "-f", "-");
  await kubectlWith(namespace(foreign, {}), "create", "-f", "-");
  await kubectlWith(deployment("labelled", own, demo), "create", "-f", "-");
  await kubectlWith(deployment("unlabelled", own, {}), "create", "-f", "-");
  await kubectlWith(deployment("labelled", foreign, demo), "create", "-f", "-");
});

afterAll(async () => {
  // Waits until they are gone: the demo's page would show the first as one of
  // its own, and its test runs after this one.
  await kubectl("delete", "namespace", own, foreign, "--ignore-not-found");
});

describe("the demo's user", () => {
  it("is the user the policy names", async () => {
    // Otherwise every refusal below could come from a role that is missing.
    expect(await kubectl("--as", user, "auth", "can-i", "delete", "namespaces")).toBe("yes");
    expect(
      await kubectl("--as", user, "auth", "can-i", "delete", "deployments", "-n", "kube-system"),
    ).toBe("yes");
  });

  describe("with namespaces", () => {
    it("creates one as the demo does", async () => {
      await createAsUser(namespace(`demo-new-${id}`, { ...demo, ...restricted }));
    });

    it("does not create one without the demo's label", async () => {
      await expect(createAsUser(namespace(`demo-new-${id}`, restricted))).rejects.toThrow(
        /may only create and delete namespaces labelled/,
      );
    });

    it("does not create one that lets pods do anything", async () => {
      await expect(createAsUser(namespace(`demo-new-${id}`, demo))).rejects.toThrow(
        /may only create namespaces labelled pod-security/,
      );
      await expect(
        createAsUser(
          namespace(`demo-new-${id}`, {
            ...demo,
            "pod-security.kubernetes.io/enforce": "privileged",
          }),
        ),
      ).rejects.toThrow(/may only create namespaces labelled pod-security/);
    });

    it("deletes one of the demo's", async () => {
      await asUser("delete", "namespace", own);
    });

    it("does not delete any other", async () => {
      for (const name of [foreign, "kube-client-web-e2e"]) {
        await expect(asUser("delete", "namespace", name), name).rejects.toThrow(
          /may only create and delete namespaces labelled/,
        );
      }
      // Kubernetes itself refuses these two before any policy is asked.
      for (const name of ["kube-system", "default"]) {
        await expect(asUser("delete", "namespace", name), name).rejects.toThrow(
          /this namespace may not be deleted/,
        );
      }
    });
  });

  describe("with deployments", () => {
    it("creates one as the demo does, in a namespace of the demo", async () => {
      await createAsUser(deployment("new", own, demo));
    });

    it("does not create one without the demo's label", async () => {
      await expect(createAsUser(deployment("new", own, {}))).rejects.toThrow(
        /may only create and delete deployments labelled/,
      );
    });

    it("does not create one in a namespace that is not the demo's", async () => {
      for (const name of [foreign, "kube-system", "default"]) {
        await expect(createAsUser(deployment("new", name, demo)), name).rejects.toThrow(
          /may only change deployments in namespaces labelled/,
        );
      }
    });

    it("deletes one of the demo's", async () => {
      await asUser("-n", own, "delete", "deployment", "labelled");
    });

    it("does not delete one without the demo's label", async () => {
      await expect(asUser("-n", own, "delete", "deployment", "unlabelled")).rejects.toThrow(
        /may only create and delete deployments labelled/,
      );
    });

    it("does not delete one in a namespace that is not the demo's", async () => {
      await expect(asUser("-n", foreign, "delete", "deployment", "labelled")).rejects.toThrow(
        /may only change deployments in namespaces labelled/,
      );
      await expect(asUser("-n", "kube-system", "delete", "deployment", "coredns")).rejects.toThrow(
        /may only change deployments in namespaces labelled/,
      );
    });

    it("scales those in a namespace of the demo", async () => {
      await asUser("-n", own, "scale", "deployment", "labelled", "--replicas=2");
    });

    it("does not scale those anywhere else", async () => {
      await expect(
        asUser("-n", foreign, "scale", "deployment", "labelled", "--replicas=2"),
      ).rejects.toThrow(/may only change deployments in namespaces labelled/);
      await expect(
        asUser("-n", "kube-system", "scale", "deployment", "coredns", "--replicas=0"),
      ).rejects.toThrow(/may only change deployments in namespaces labelled/);
    });

    it("does not change one in any other way", async () => {
      // Not the policy's doing: the role has no verb for it.
      await expect(
        asUser("-n", own, "label", "deployment", "labelled", "changed=yes"),
      ).rejects.toThrow(/forbidden/i);
    });
  });
});
