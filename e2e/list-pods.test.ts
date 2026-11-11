import { describe, expect, inject, it } from "vitest";
import { joinUrl } from "../src/index.ts";

const apiServer = inject("apiServer");
const token = inject("token");

describe("API server access from the browser", () => {
  it("runs in a real browser on a different origin than the API server", () => {
    expect(typeof window).toBe("object");
    expect(window.location.origin).not.toBe(new URL(apiServer).origin);
  });

  it("lists Pods with a bearer token", async () => {
    // The Authorization header makes this a preflighted cross-origin request,
    // so it only succeeds if the API server's CORS configuration is in effect.
    const response = await fetch(joinUrl(apiServer, "/api/v1/namespaces/kube-system/pods"), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { kind: string; items: unknown[] };
    expect(body.kind).toBe("PodList");
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("is rejected without a token", async () => {
    const response = await fetch(joinUrl(apiServer, "/api/v1/namespaces/kube-system/pods"));
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThanOrEqual(403);
  });
});
