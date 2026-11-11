import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const cluster = "kube-client-web";
/** Name of the test ServiceAccount, which lives in the `default` namespace. */
export const serviceAccount = "kube-client-web-e2e";

/** Runs kubectl against the test cluster and returns its trimmed output. */
export async function kubectl(...args: string[]): Promise<string> {
  const { stdout } = await run("kubectl", ["--context", `kind-${cluster}`, ...args]);
  return stdout.trim();
}

/** Runs a shell command inside the cluster's control plane node. */
export async function onControlPlane(script: string): Promise<string> {
  const { stdout } = await run("docker", ["exec", `${cluster}-control-plane`, "sh", "-c", script]);
  return stdout.trim();
}
