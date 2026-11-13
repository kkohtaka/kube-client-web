import { defineConfig } from "vite";
import { kubectl } from "../kubectl.ts";

/**
 * Serves the page the OIDC test drives. Unlike the demo, it reaches the API
 * server and the provider directly, as a deployed application would: both
 * allow cross-origin requests from pages on localhost.
 */
export default defineConfig(async () => ({
  root: import.meta.dirname,
  define: {
    __API_SERVER__: JSON.stringify(
      await kubectl("config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"),
    ),
    __ISSUER__: JSON.stringify("https://127.0.0.1:5556/dex"),
  },
}));
