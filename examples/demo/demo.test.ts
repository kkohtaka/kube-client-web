import { resolve } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { type Browser, chromium, type Locator, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kubectl } from "../../e2e/kubectl.ts";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let url: string;
/** Namespaces made by the test, removed at the end whatever happened. */
const leftovers: string[] = [];

beforeAll(async () => {
  server = await createServer({ configFile: resolve(import.meta.dirname, "vite.config.ts") });
  await server.listen();
  const local = server.resolvedUrls?.local[0];
  if (!local) {
    throw new Error("the dev server did not report its address");
  }
  // The provider lets a public client redirect to localhost only.
  url = local.replace("127.0.0.1", "localhost");
  browser = await chromium.launch();
  // axe opens a page of its own, which needs an explicit context. The
  // provider's sign-in page has a certificate the browser does not trust.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });
  page = await context.newPage();
  await page.goto(url);
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  for (const name of leftovers) {
    await kubectl("delete", "namespace", name, "--ignore-not-found", "--wait=false");
  }
});

/** Saved for a look at the page; CI keeps them as an artifact. */
async function screenshot(name: string): Promise<void> {
  // Let shapes that just appeared, and colors that just changed, settle. The
  // animations of pending and terminating pods never end and are not waited for.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    ),
  );
  await page.screenshot({
    path: resolve(import.meta.dirname, "screenshots", `${name}.png`),
    fullPage: true,
  });
}

/** Checks the page as it is now for accessibility problems, in both color schemes. */
async function expectAccessible(): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.map(({ id, help, nodes }) => ({ id, help, nodes: nodes.map((n) => n.html) })),
      `accessibility in the ${colorScheme} color scheme`,
    ).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

function namespace(name: string): Locator {
  return page.locator(`.namespace[data-namespace="${name}"]:not(.leaving)`);
}

/** The pods drawn for a deployment, apart from those on their way out. */
function podsOf(group: Locator, state?: string): Locator {
  return group.locator(`.pod:not(.leaving)${state ? `[data-state="${state}"]` : ""}`);
}

async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

describe("the demo page", () => {
  let own: Locator;
  let ownName: string;
  let group: Locator;
  let deployment: string;

  it("asks to sign in first", async () => {
    await page.getByTestId("signed-out").waitFor();
    expect(await page.getByTestId("map").isVisible()).toBe(false);
    await screenshot("signed-out");
    await expectAccessible();
  });

  it("signs in with the cluster's OpenID Connect provider", async () => {
    await page.getByTestId("sign-in").click();
    await page.waitForURL(/^https:\/\/127\.0\.0\.1:5556\/dex\//);
    await page.locator('input[name="login"]').fill("jane@example.com");
    await page.locator('input[name="password"]').fill("password");
    await page.locator('button[type="submit"]').click();

    await page.waitForURL((to) => to.href === url);
    await page.locator('[data-testid="status"][data-state="synced"]').waitFor();
    expect(await page.getByTestId("user").textContent()).toBe("jane@example.com");
  });

  it("draws the namespaces of the cluster with their pods", async () => {
    const system = namespace("kube-system");
    await system.waitFor();
    // The control plane's pods have no deployment; CoreDNS has one.
    expect(await podsOf(system.locator(".group:not([data-deployment])")).count()).toBeGreaterThan(
      2,
    );
    expect(await podsOf(system.locator('.group[data-deployment="coredns"]')).count()).toBe(2);
    // Nothing that was not made here can be changed from here.
    expect(await system.locator("button").count()).toBe(0);
    expect(await page.getByTestId("count").textContent()).toMatch(
      /^\d+ namespaces · \d+ deployments · \d+ pods$/,
    );
  });

  it("creates a namespace from the page", async () => {
    await page.getByTestId("create-namespace").click();
    own = page.locator(".namespace[data-own]:not(.leaving)");
    await own.waitFor();
    ownName = String(await own.getAttribute("data-namespace"));
    leftovers.push(ownName);

    expect(ownName).toMatch(/^demo-/);
    expect(await kubectl("get", "namespace", ownName, "-o", "name")).toBe(`namespace/${ownName}`);
    // It comes first, ahead of the namespaces that were already there.
    expect(await page.locator(".namespace").first().getAttribute("data-namespace")).toBe(ownName);
  });

  it("adds a deployment and shows its pods come up", async () => {
    await own.getByTestId("add-deployment").click();
    group = own.locator(".group[data-deployment]");
    await group.waitFor();
    deployment = String(await group.getAttribute("data-deployment"));

    await eventually(
      async () => (await podsOf(group, "Running").count()) === 3,
      "three running pods",
    );
    expect(await podsOf(group).count()).toBe(3);
    expect(await group.locator(".replicas").textContent()).toBe("3 of 3 ready");
    expect(await podsOf(group).first().textContent()).toMatch(
      new RegExp(`^${deployment}-.+: Running$`),
    );
  });

  it("scales the deployment up and down", async () => {
    await group.getByTestId("scale-up").click();
    await eventually(async () => (await podsOf(group, "Running").count()) === 4, "a fourth pod");

    await group.getByTestId("scale-down").click();
    await group.getByTestId("scale-down").click();
    await eventually(async () => (await podsOf(group).count()) === 2, "two pods to remain");
    expect(await group.locator(".replicas").textContent()).toBe("2 of 2 ready");
  });

  it("shows a change made with kubectl without reloading", async () => {
    await kubectl("-n", ownName, "scale", "deployment", deployment, "--replicas=5");
    await eventually(async () => (await podsOf(group, "Running").count()) === 5, "five pods");
    expect(await page.getByTestId("log").textContent()).toContain(`pod ${ownName}/${deployment}-`);

    await screenshot("map");
    await page.emulateMedia({ colorScheme: "dark" });
    await screenshot("map-dark");
    await expectAccessible();
  });

  it("deletes the deployment, and its pods go", async () => {
    await group.getByTestId("delete-deployment").click();
    await eventually(async () => (await group.count()) === 0, "the deployment to go");
    await eventually(
      async () => (await own.locator(".pod:not(.leaving)").count()) === 0,
      "the pods to go",
    );
    expect(await own.locator(".empty").isVisible()).toBe(true);
  });

  it("deletes the namespace", async () => {
    await own.getByTestId("delete-namespace").click();
    await eventually(async () => (await namespace(ownName).count()) === 0, "the namespace to go");
    await expect(kubectl("get", "namespace", ownName)).rejects.toThrow(/NotFound/);
  });

  it("stays signed in across a reload, and signs out", async () => {
    await page.reload();
    await page.locator('[data-testid="status"][data-state="synced"]').waitFor();
    await namespace("kube-system").waitFor();

    await page.getByTestId("sign-out").click();
    await page.getByTestId("signed-out").waitFor();
    expect(await page.getByTestId("map").isVisible()).toBe(false);

    await page.reload();
    await page.getByTestId("signed-out").waitFor();
  });
});
