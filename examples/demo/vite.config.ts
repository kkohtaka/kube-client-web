import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { kubectl, serviceAccount } from "../../e2e/kubectl.ts";

const tokenLifetimeSeconds = 600;

/**
 * Serves `/token`: a fresh, short-lived token for the test identity of the
 * kind cluster. It stands in for whatever hands your application its tokens,
 * typically an OIDC provider. Never expose something like this beyond your
 * own machine.
 */
function tokenEndpoint(): Plugin {
  return {
    name: "demo-token-endpoint",
    configureServer(server) {
      server.middlewares.use("/token", (_request, response) => {
        kubectl(
          "-n",
          "default",
          "create",
          "token",
          serviceAccount,
          `--duration=${tokenLifetimeSeconds}s`,
        ).then(
          (token) => {
            response.setHeader("Content-Type", "application/json");
            response.setHeader("Cache-Control", "no-store");
            response.end(
              JSON.stringify({ token, expiresAt: Date.now() + tokenLifetimeSeconds * 1000 }),
            );
          },
          (error: unknown) => {
            response.statusCode = 500;
            response.end(String(error));
          },
        );
      });
    },
  };
}

export default defineConfig(async () => {
  const apiServer = await kubectl(
    "config",
    "view",
    "--minify",
    "-o",
    "jsonpath={.clusters[0].cluster.server}",
  ).catch((error: unknown) => {
    throw new Error("The demo needs the kind cluster. Create it with `pnpm e2e:up`.", {
      cause: error,
    });
  });
  return {
    root: import.meta.dirname,
    resolve: {
      // Lets the demo import the library by name, as an application would.
      alias: { "kube-client-web": resolve(import.meta.dirname, "../../src/index.ts") },
    },
    plugins: [tokenEndpoint()],
    server: {
      proxy: {
        // The page reaches the API server through the dev server, so the
        // browser neither has to trust kind's certificate nor needs CORS.
        // A deployed application talks to the API server directly instead.
        "/k8s": {
          target: apiServer,
          secure: false,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/k8s/, ""),
        },
      },
    },
  };
});
