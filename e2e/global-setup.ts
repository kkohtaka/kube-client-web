import { execFileSync } from "node:child_process";
import type { TestProject } from "vitest/node";

const context = "kind-kube-client-web";

function kubectl(...args: string[]): string {
  return execFileSync("kubectl", ["--context", context, ...args], { encoding: "utf8" }).trim();
}

/**
 * Runs in Node before the browser tests. Reads the API server address from the
 * kubeconfig and mints a short-lived token for the test ServiceAccount, then
 * hands both to the tests.
 */
export default function setup(project: TestProject): void {
  const apiServer = kubectl(
    "config",
    "view",
    "--minify",
    "-o",
    "jsonpath={.clusters[0].cluster.server}",
  );
  const token = kubectl(
    "-n",
    "default",
    "create",
    "token",
    "kube-client-web-e2e",
    "--duration=10m",
  );
  project.provide("apiServer", apiServer);
  project.provide("token", token);
}

declare module "vitest" {
  export interface ProvidedContext {
    apiServer: string;
    token: string;
  }
}
