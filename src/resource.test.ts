import { describe, expect, it } from "vitest";
import { defineResource, resourcePath } from "./resource.ts";

const pods = defineResource({ version: "v1", resource: "pods", namespaced: true });
const nodes = defineResource({ version: "v1", resource: "nodes", namespaced: false });
const deployments = defineResource({
  group: "apps",
  version: "v1",
  resource: "deployments",
  namespaced: true,
});
const widgets = defineResource({
  group: "example.test",
  version: "v1alpha1",
  resource: "widgets",
  namespaced: true,
});

describe("resourcePath", () => {
  it("uses /api for the core group", () => {
    expect(resourcePath(pods, { namespace: "default" })).toBe("/api/v1/namespaces/default/pods");
  });

  it("treats an empty group as the core group", () => {
    const resource = defineResource({
      group: "",
      version: "v1",
      resource: "pods",
      namespaced: true,
    });
    expect(resourcePath(resource)).toBe("/api/v1/pods");
  });

  it("uses /apis/<group> for named groups, including custom resources", () => {
    expect(resourcePath(deployments, { namespace: "default", name: "web" })).toBe(
      "/apis/apps/v1/namespaces/default/deployments/web",
    );
    expect(resourcePath(widgets, { namespace: "default" })).toBe(
      "/apis/example.test/v1alpha1/namespaces/default/widgets",
    );
  });

  it("addresses a namespaced collection across all namespaces when none is given", () => {
    expect(resourcePath(pods)).toBe("/api/v1/pods");
  });

  it("addresses cluster-scoped resources without a namespace segment", () => {
    expect(resourcePath(nodes)).toBe("/api/v1/nodes");
    expect(resourcePath(nodes, { name: "node-1" })).toBe("/api/v1/nodes/node-1");
  });

  it("appends a subresource", () => {
    expect(resourcePath(pods, { namespace: "default", name: "web", subresource: "status" })).toBe(
      "/api/v1/namespaces/default/pods/web/status",
    );
  });

  it("percent-encodes path segments", () => {
    expect(resourcePath(nodes, { name: "a/b c" })).toBe("/api/v1/nodes/a%2Fb%20c");
  });

  it("rejects a namespace for a cluster-scoped resource", () => {
    expect(() => resourcePath(nodes, { namespace: "default" })).toThrow(/cluster-scoped/);
  });

  it("requires a namespace to address a single namespaced object", () => {
    expect(() => resourcePath(pods, { name: "web" })).toThrow(/namespace is required/);
  });

  it("requires a name to address a subresource", () => {
    expect(() => resourcePath(pods, { namespace: "default", subresource: "status" })).toThrow(
      /name is required/,
    );
  });
});
