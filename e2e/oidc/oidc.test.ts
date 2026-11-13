import { resolve } from "node:path";
import { type Browser, type BrowserType, chromium, firefox, type Page, webkit } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Signs in through Dex in a real browser. The page under test is ./index.html;
 * it shows what the API server answers to the token it got.
 */

let server: ViteDevServer;
let url: string;

beforeAll(async () => {
  server = await createServer({ configFile: resolve(import.meta.dirname, "vite.config.ts") });
  await server.listen();
  const local = server.resolvedUrls?.local[0];
  if (!local) {
    throw new Error("the dev server did not report its address");
  }
  // Dex lets a public client redirect to localhost only, not to 127.0.0.1.
  url = local.replace("127.0.0.1", "localhost");
});

afterAll(async () => {
  await server?.close();
});

const browsers: [string, BrowserType][] = [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
];

describe.each(browsers)("signing in with OpenID Connect in %s", (_name, type) => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await type.launch();
    // Neither Dex's nor the API server's certificate is one the browser trusts.
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();
  });

  afterAll(async () => {
    await browser?.close();
  });

  function state(name: string) {
    return page.locator(`#state[data-state="${name}"]`);
  }

  async function settled(): Promise<string> {
    await page.locator('#state:not([data-state="loading"])').waitFor();
    const error = await page.locator("#error").textContent();
    return `${await page.locator("#state").getAttribute("data-state")}${error ? `: ${error}` : ""}`;
  }

  it("starts signed out", async () => {
    await page.goto(url);
    expect(await settled()).toBe("signed-out");
  });

  it("signs in at the provider and is known to the API server", async () => {
    await page.locator("#sign-in").click();
    await page.waitForURL(/^https:\/\/127\.0\.0\.1:5556\/dex\//);
    await page.locator('input[name="login"]').fill("jane@example.com");
    await page.locator('input[name="password"]').fill("password");
    await page.locator('button[type="submit"]').click();

    await page.waitForURL((to) => to.href.startsWith(url));
    expect(await settled()).toBe("signed-in");
    expect(await page.locator("#user").textContent()).toBe("jane@example.com");
    expect(await page.locator("#whoami").textContent()).toBe("oidc:jane@example.com");
    expect(Number(await page.locator("#configmaps").textContent())).toBeGreaterThan(0);
    // The provider's answer is gone from the address bar.
    expect(page.url()).toBe(url);
  });

  it("stays signed in across a reload, without a visit to the provider", async () => {
    const visits: string[] = [];
    page.on("framenavigated", (frame) => visits.push(frame.url()));

    await page.reload();

    expect(await settled()).toBe("signed-in");
    expect(await page.locator("#whoami").textContent()).toBe("oidc:jane@example.com");
    expect(visits.filter((visit) => visit.includes(":5556"))).toEqual([]);
  });

  it("renews the token, and the API server accepts the new one", async () => {
    await page.locator("#renew").click();
    await page.locator("#renewals", { hasText: "1" }).waitFor();

    expect(await settled()).toBe("signed-in");
    expect(await page.locator("#whoami").textContent()).toBe("oidc:jane@example.com");
  });

  it("is signed out after signing out, also after a reload", async () => {
    await page.locator("#sign-out").click();
    await state("signed-out").waitFor();

    await page.reload();
    expect(await settled()).toBe("signed-out");
    await page.locator("#call").click();
    expect(await settled()).toBe("error: SignInRequiredError: not signed in");
  });
});
