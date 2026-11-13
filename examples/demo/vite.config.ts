import { resolve } from "node:path";
import { defineConfig } from "vite";
import { kubectl } from "../../e2e/kubectl.ts";

export default defineConfig(async ({ command }) => {
  const shared = {
    root: import.meta.dirname,
    resolve: {
      // Lets the demo import the library by name, as an application would.
      alias: { "kube-client-web": resolve(import.meta.dirname, "../../src/index.ts") },
    },
  };
  if (command === "build") {
    // Building only checks that the page bundles; it needs no cluster.
    return shared;
  }

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
    ...shared,
    server: {
      proxy: {
        // The page reaches the API server and the OpenID Connect provider
        // through the dev server, so the browser neither has to trust their
        // certificates nor needs CORS. A deployed application talks to both
        // directly instead.
        "/k8s": {
          target: apiServer,
          secure: false,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/k8s/, ""),
        },
        "/idp": {
          target: "https://127.0.0.1:5556",
          secure: false,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/idp/, ""),
        },
      },
    },
  };
});
