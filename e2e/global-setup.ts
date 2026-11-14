import type { TestProject } from "vitest/node";
import { kubectl, serviceAccount } from "./kubectl.ts";

/**
 * Runs in Node before the browser tests. Reads the API server address from the
 * kubeconfig and mints a short-lived token for the test ServiceAccount, then
 * hands both to the tests, with the name of an image for pods that write a
 * log.
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
  // Tests that need a container with a shell use an image every kind node
  // already has, so that nothing is pulled: the helper of its storage
  // provisioner, which holds a shell and little else.
  const images = await kubectl(
    "get",
    "nodes",
    "-o",
    "jsonpath={.items[0].status.images[*].names[*]}",
  );
  const shellImage = images
    .split(/\s+/)
    .find((name) => /\/local-path-helper:/.test(name) && !name.includes("@"));
  if (!shellImage) {
    throw new Error(`the node has no local-path-helper image to run a shell in; it has: ${images}`);
  }
  project.provide("shellImage", shellImage);
  project.provide("apiServer", apiServer);
  project.provide("token", token);
}

declare module "vitest" {
  export interface ProvidedContext {
    apiServer: string;
    shellImage: string;
    token: string;
  }
}
