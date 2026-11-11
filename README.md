# kube-client-web

A Kubernetes client library for the browser, with informer support.

> **Status:** early development. Nothing is published yet and the API is not stable.
> REST operations work today; watch and informers are not implemented yet.

## Goals

- Talk to a Kubernetes API server directly from the browser using `fetch`.
- Provide informers (list + watch with a local cache), not just REST calls.
- Ship as ESM with TypeScript types and no runtime dependencies.

## Usage

```ts
import { ApiError, createClient, defineResource, type KubeObject } from "kube-client-web";

const client = createClient({
  baseUrl: "https://kubernetes.example.com:6443",
  // A string, or a function that returns the current token. The function is
  // called once per request, so it can hand out a refreshed token.
  token: () => getAccessToken(),
});
```

The library does not ship types for individual resources. Describe a resource
once, with the object type of your choice, and get a typed client for it.
Built-in and custom resources work the same way.

```ts
interface ConfigMap extends KubeObject {
  data?: Record<string, string>;
}

const configMaps = client.resource(
  defineResource<ConfigMap>({ version: "v1", resource: "configmaps", namespaced: true }),
);

const widgets = client.resource(
  defineResource<Widget>({
    group: "example.com",
    version: "v1",
    resource: "widgets",
    namespaced: true,
  }),
);
```

```ts
// Read
const cm = await configMaps.get("settings", { namespace: "default" });
const page = await configMaps.list({ namespace: "default", labelSelector: "app=web" });
const everywhere = await configMaps.list(); // all namespaces

// Page through a large list
for await (const page of configMaps.listPages({ namespace: "default", limit: 100 })) {
  // page.items
}

// Write
await configMaps.create({ metadata: { name: "settings", namespace: "default" }, data: { a: "1" } });
await configMaps.update({ ...cm, data: { a: "2" } });
await configMaps.patch("settings", { data: { b: "3" } }, { namespace: "default" });
await configMaps.apply(
  { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "settings", namespace: "default" } },
  { fieldManager: "my-app" },
);
await configMaps.delete("settings", { namespace: "default" });
```

A non-2xx answer from the API server is thrown as an `ApiError` carrying the
HTTP status and the server's `Status` object:

```ts
try {
  await configMaps.get("missing", { namespace: "default" });
} catch (error) {
  if (error instanceof ApiError && error.reason === "NotFound") {
    // ...
  }
}
```

Every operation accepts an `AbortSignal` as `signal`.

## Cluster requirements

Browsers enforce restrictions that other clients do not, so the cluster has to
cooperate:

- **CORS.** Start `kube-apiserver` with `--cors-allowed-origins` matching the
  origin your page is served from. See [`e2e/kind-config.yaml`](e2e/kind-config.yaml)
  for a working example.
- **Authentication.** Only bearer tokens are supported. Client certificates and
  kubeconfig exec plugins are not available to a web page.
- **TLS.** The API server certificate must be trusted by the browser.

## Development

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

End-to-end tests run in Chromium against a local [kind](https://kind.sigs.k8s.io/) cluster:

```sh
pnpm exec playwright install chromium
pnpm e2e:up      # create the cluster and test fixtures
pnpm test:e2e
pnpm e2e:down
```

## Disclaimer

This is an unofficial project. It is not affiliated with or endorsed by the
Kubernetes project or the Linux Foundation.

## License

[Apache License 2.0](LICENSE)
