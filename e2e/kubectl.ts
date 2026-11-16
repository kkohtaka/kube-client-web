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

/** Runs kubectl with a manifest on its standard input, such as for `create -f -`. */
export async function kubectlWith(manifest: object, ...args: string[]): Promise<string> {
  const running = run("kubectl", ["--context", `kind-${cluster}`, ...args]);
  running.child.stdin?.end(JSON.stringify(manifest));
  return (await running).stdout.trim();
}

/** Runs a shell command inside the cluster's control plane node. */
export async function onControlPlane(script: string): Promise<string> {
  const { stdout } = await run("docker", ["exec", `${cluster}-control-plane`, "sh", "-c", script]);
  return stdout.trim();
}

/** Creates an empty ConfigMap with the given labels. */
export async function createConfigMap(
  namespace: string,
  name: string,
  labels: Record<string, string>,
): Promise<void> {
  await kubectl("-n", namespace, "create", "configmap", name);
  const pairs = Object.entries(labels).map(([key, value]) => `${key}=${value}`);
  // `kubectl create configmap` takes no labels. A watch with a label selector
  // reports the object as added once it matches.
  await kubectl("-n", namespace, "label", "configmap", name, ...pairs);
}
