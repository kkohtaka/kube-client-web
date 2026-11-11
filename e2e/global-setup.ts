import type { TestProject } from "vitest/node";
import { kubectl, serviceAccount } from "./kubectl.ts";

/**
 * Runs in Node before the browser tests. Reads the API server address from the
 * kubeconfig and mints a short-lived token for the test ServiceAccount, then
 * hands both to the tests.
 */
export default async function setup(project: TestProject): Promise<void> {
  const apiServer = await kubectl(
    "config",
    "view",
    "--minify",
    "-o",
    "jsonpath={.clusters[0].cluster.server}",
  );
  const token = await kubectl("-n", "default", "create", "token", serviceAccount, "--duration=10m");
  project.provide("apiServer", apiServer);
  project.provide("token", token);
}

declare module "vitest" {
  export interface ProvidedContext {
    apiServer: string;
    token: string;
  }
}
