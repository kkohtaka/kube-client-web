import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kubectl } from "../../e2e/kubectl.ts";

const namespace = "kube-client-web-e2e";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
const leftovers: string[] = [];

beforeAll(async () => {
  server = await createServer({ configFile: resolve(import.meta.dirname, "vite.config.ts") });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) {
    throw new Error("the dev server did not report its address");
  }
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(url);
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  for (const name of leftovers) {
    await kubectl("-n", namespace, "delete", "configmap", name, "--ignore-not-found");
  }
});

function row(name: string, inNamespace = namespace) {
  return page.locator(`tr[data-key="${inNamespace}/${name}"]`);
}

describe("the demo page", () => {
  it("shows the ConfigMaps of the demo namespace once synced", async () => {
    await page.locator('[data-testid="status"][data-state="synced"]').waitFor();
    // Kubernetes puts this one into every namespace.
    await row("kube-root-ca.crt").waitFor();
    expect(await row("kube-root-ca.crt").locator("td.name").textContent()).toBe("kube-root-ca.crt");
  });

  it("shows a change made with kubectl without reloading", async () => {
    const name = `demo-test-${Date.now()}`;
    leftovers.push(name);
    await kubectl("-n", namespace, "create", "configmap", name, "--from-literal=greeting=hello");
    await row(name).waitFor();
    expect(await row(name).textContent()).toContain("greeting");

    await kubectl("-n", namespace, "delete", "configmap", name);
    await row(name).waitFor({ state: "detached" });
  });

  it("creates and deletes a ConfigMap from the page", async () => {
    const before = await page.locator("tr[data-key]").count();
    await page.getByTestId("create").click();
    const created = page.locator(`tr[data-key^="${namespace}/demo-"]`).first();
    await created.waitFor();
    const key = await created.getAttribute("data-key");
    leftovers.push(String(key).split("/")[1] ?? "");
    expect(await page.locator("tr[data-key]").count()).toBe(before + 1);

    await created.getByTestId("delete").click();
    await page.locator(`tr[data-key="${key}"]`).waitFor({ state: "detached" });
    expect(await page.getByTestId("log").textContent()).toContain(`delete ${key}`);
  });

  it("switches to Pods across all namespaces", async () => {
    await page.getByTestId("view-pods").click();
    await page.locator('[data-testid="status"][data-state="synced"]').waitFor();
    await page.locator('tr[data-key^="kube-system/kube-apiserver-"]').waitFor();
    expect(await page.locator("tr[data-key]").count()).toBeGreaterThan(3);
    // Pods are read-only in the demo.
    expect(await page.getByTestId("create").isHidden()).toBe(true);
    expect(await page.getByTestId("delete").count()).toBe(0);
  });
});
