import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

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
          include: ["e2e/**/*.test.ts"],
          globalSetup: ["e2e/global-setup.ts"],
          browser: {
            enabled: true,
            headless: true,
            // kind's API server certificate is signed by a cluster-local CA
            // that the browser does not trust.
            provider: playwright({ contextOptions: { ignoreHTTPSErrors: true } }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
