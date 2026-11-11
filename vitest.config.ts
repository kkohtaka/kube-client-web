import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { commands } from "./e2e/commands.ts";

const browsers = ["chromium", "firefox", "webkit"] as const;

function browser(...names: (typeof browsers)[number][]) {
  return {
    enabled: true,
    headless: true,
    // kind's API server certificate is signed by a cluster-local CA that the
    // browsers do not trust.
    provider: playwright({ contextOptions: { ignoreHTTPSErrors: true } }),
    instances: names.map((name) => ({ browser: name })),
    commands,
  };
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "e2e",
          include: ["e2e/*.test.ts"],
          globalSetup: ["e2e/global-setup.ts"],
          browser: browser(...browsers),
        },
      },
      // Tests that break the cluster on purpose. They would disturb the other
      // tests and each other, so each browser gets a project of its own and
      // the test:e2e:faults script runs them one after the other.
      ...browsers.map((name) => ({
        test: {
          name: `faults-${name}`,
          include: ["e2e/faults/*.test.ts"],
          globalSetup: ["e2e/global-setup.ts"],
          browser: browser(name),
        },
      })),
    ],
  },
});
