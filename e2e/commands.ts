import { randomUUID } from "node:crypto";
import type { BrowserCommand } from "vitest/node";
import { kubectl, onControlPlane, serviceAccount } from "./kubectl.ts";

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

export const commands: Record<string, BrowserCommand<never[]>> = {
  createRevocableToken,
  revokeToken,
  restartApiServer,
};

declare module "vitest/browser" {
  interface BrowserCommands {
    createRevocableToken: () => Promise<RevocableToken>;
    revokeToken: (secret: string) => Promise<void>;
    restartApiServer: () => Promise<void>;
  }
}
