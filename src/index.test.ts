import { describe, expect, it } from "vitest";
import { joinUrl } from "./index.ts";

describe("joinUrl", () => {
  it("joins a base URL and a path", () => {
    expect(joinUrl("https://127.0.0.1:6443", "/api/v1/pods")).toBe(
      "https://127.0.0.1:6443/api/v1/pods",
    );
  });

  it("collapses duplicate slashes at the boundary", () => {
    expect(joinUrl("https://example.test/", "/api/v1/pods")).toBe(
      "https://example.test/api/v1/pods",
    );
  });

  it("preserves a path prefix on the base URL", () => {
    expect(joinUrl("https://example.test/k8s/", "api/v1/pods")).toBe(
      "https://example.test/k8s/api/v1/pods",
    );
  });
});
