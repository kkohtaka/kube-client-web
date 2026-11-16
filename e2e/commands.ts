import { randomUUID } from "node:crypto";
import type { BrowserCommand } from "vitest/node";
import { createConfigMap, kubectl, onControlPlane, serviceAccount } from "./kubectl.ts";

/**
 * Things the browser tests ask the test runner to do to the cluster, because
 * a web page cannot. Called through `commands` from `vitest/browser`.
 */

export interface RevocableToken {
  token: string;
  /** Pass to `revokeToken` to make the token invalid. */
  secret: string;
}

/**
 * Mints a token for the test identity that is only valid while a Secret
 * created for it exists. Deleting that Secret is the closest thing to a token
 * expiring that can be triggered on demand.
 */
const createRevocableToken: BrowserCommand<[]> = async (): Promise<RevocableToken> => {
  const secret = `e2e-token-${randomUUID().slice(0, 8)}`;
  await kubectl("-n", "default", "create", "secret", "generic", secret);
  const token = await kubectl(
    "-n",
    "default",
    "create",
    "token",
    serviceAccount,
    "--bound-object-kind=Secret",
    `--bound-object-name=${secret}`,
    "--duration=10m",
  );
  return { token, secret };
};

const revokeToken: BrowserCommand<[secret: string]> = async (_context, secret): Promise<void> => {
  await kubectl("-n", "default", "delete", "secret", secret, "--ignore-not-found");
};

/** Stops the API server and returns once the kubelet has brought it back. */
const restartApiServer: BrowserCommand<[]> = async (): Promise<void> => {
  await onControlPlane("crictl stop $(crictl ps -q --name kube-apiserver)");
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await kubectl("get", "--raw", "/readyz");
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error("the API server did not come back", { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
};

/** A ConfigMap for `createConfigMapsLater` to create. */
export interface LaterConfigMap {
  /** When to create it, in milliseconds from now. */
  afterMs: number;
  namespace: string;
  name: string;
  labels: Record<string, string>;
}

const later = new Map<string, Promise<void>>();

/**
 * Creates ConfigMaps a while from now, for tests whose page cannot do it
 * because it is kept from running at that time. Returns at once, with what
 * to pass to `createdLater` to wait for them.
 */
const createConfigMapsLater: BrowserCommand<[configMaps: LaterConfigMap[]]> = async (
  _context,
  configMaps,
): Promise<string> => {
  const id = randomUUID();
  const done = Promise.all(
    configMaps.map(async ({ afterMs, namespace, name, labels }) => {
      await new Promise((resolve) => setTimeout(resolve, afterMs));
      await createConfigMap(namespace, name, labels);
    }),
  ).then(() => undefined);
  // Reported to whoever asks with `createdLater`.
  done.catch(() => undefined);
  later.set(id, done);
  return id;
};

/** Returns once the ConfigMaps of one `createConfigMapsLater` exist; fails if that failed. */
const createdLater: BrowserCommand<[id: string]> = async (_context, id): Promise<void> => {
  const done = later.get(id);
  later.delete(id);
  await done;
};

export const commands: Record<string, BrowserCommand<never[]>> = {
  createRevocableToken,
  revokeToken,
  restartApiServer,
  createConfigMapsLater,
  createdLater,
};

declare module "vitest/browser" {
  interface BrowserCommands {
    createRevocableToken: () => Promise<RevocableToken>;
    revokeToken: (secret: string) => Promise<void>;
    restartApiServer: () => Promise<void>;
    createConfigMapsLater: (configMaps: LaterConfigMap[]) => Promise<string>;
    createdLater: (id: string) => Promise<void>;
  }
}
