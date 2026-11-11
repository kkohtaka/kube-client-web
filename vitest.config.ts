import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { commands } from "./e2e/commands.ts";

const browser = {
  enabled: true,
  headless: true,
  // kind's API server certificate is signed by a cluster-local CA that the
  // browsers do not trust.
  provider: playwright({ contextOptions: { ignoreHTTPSErrors: true } }),
  instances: [{ browser: "chromium" }, { browser: "firefox" }, { browser: "webkit" }],
  commands,
} as const;

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
          browser,
        },
      },
      {
        // Tests that break the cluster on purpose. They would disturb the
        // other tests and each other, so they run separately, one browser at
        // a time (see the test:e2e:faults script).
        test: {
          name: "faults",
          include: ["e2e/faults/*.test.ts"],
          globalSetup: ["e2e/global-setup.ts"],
          browser,
        },
      },
    ],
  },
});
