import { describe, expect, inject, it } from "vitest";
import { ApiError, createClient } from "../src/index.ts";
import { client, deployments, hidesUnauthenticatedAnswers, namespaces, pods } from "./fixtures.ts";

describe("reading from the browser", () => {
  it("runs in a real browser on a different origin than the API server", () => {
    expect(typeof window).toBe("object");
    expect(window.location.origin).not.toBe(new URL(inject("apiServer")).origin);
  });

  it("lists Pods in a namespace", async () => {
    // The Authorization header makes this a preflighted cross-origin request,
    // so it only succeeds if the API server's CORS configuration is in effect.
    const list = await client().resource(pods).list({ namespace: "kube-system" });
    expect(list.kind).toBe("PodList");
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((pod) => pod.metadata?.namespace === "kube-system")).toBe(true);
  });

  it("lists a namespaced resource across all namespaces", async () => {
    const list = await client().resource(pods).list();
    expect(list.items.length).toBeGreaterThan(0);
  });

  it("filters with a label selector", async () => {
    const list = await client()
      .resource(pods)
      .list({ namespace: "kube-system", labelSelector: "component=kube-apiserver" });
    expect(list.items).toHaveLength(1);
  });

  it("reads a cluster-scoped resource", async () => {
    const ns = await client().resource(namespaces).get("kube-system");
    expect(ns.metadata?.name).toBe("kube-system");
  });

  it("reads a resource in a named API group", async () => {
    const coredns = await client()
      .resource(deployments)
      .get("coredns", { namespace: "kube-system" });
    expect(coredns.kind).toBe("Deployment");
  });

  it("pages through a list", async () => {
    const all = await client().resource(pods).list({ namespace: "kube-system" });
    expect(all.items.length).toBeGreaterThan(2);

    const names: (string | undefined)[] = [];
    let pageCount = 0;
    for await (const page of client()
      .resource(pods)
      .listPages({ namespace: "kube-system", limit: 2 })) {
      expect(page.items.length).toBeLessThanOrEqual(2);
      names.push(...page.items.map((pod) => pod.metadata?.name));
      pageCount++;
    }
    expect(pageCount).toBeGreaterThan(1);
    expect(names.sort()).toEqual(all.items.map((pod) => pod.metadata?.name).sort());
  });
});

describe("errors from the browser", () => {
  it("reports a missing object as NotFound", async () => {
    const error = await client()
      .resource(pods)
      .get("does-not-exist", { namespace: "kube-system" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).reason).toBe("NotFound");
  });

  it("is rejected without a token", async () => {
    const anonymous = createClient({ baseUrl: inject("apiServer") });
    const error = await anonymous
      .resource(pods)
      .list({ namespace: "kube-system" })
      .catch((e: unknown) => e);
    if (hidesUnauthenticatedAnswers) {
      expect(error).toBeInstanceOf(TypeError);
    } else {
      // kind lets anonymous requests in, as a user without any permission.
      expect(error).toMatchObject({ status: 403, reason: "Forbidden" });
    }
  });

  it("is rejected with a token the server does not accept", async () => {
    const stranger = createClient({ baseUrl: inject("apiServer"), token: "not-a-valid-token" });
    const error = await stranger
      .resource(pods)
      .list({ namespace: "kube-system" })
      .catch((e: unknown) => e);
    if (hidesUnauthenticatedAnswers) {
      expect(error).toBeInstanceOf(TypeError);
    } else {
      expect(error).toMatchObject({ status: 401, reason: "Unauthorized" });
    }
  });

  it("is forbidden from writing outside the test namespace", async () => {
    const error = await client()
      .resource(pods)
      .delete("does-not-matter", { namespace: "kube-system" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).reason).toBe("Forbidden");
  });
});
