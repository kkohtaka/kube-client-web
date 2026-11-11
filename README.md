# kube-client-web

A Kubernetes client library for the browser, with informer support.

> **Status:** early development. Nothing is published yet and the API is not stable.
> REST operations, watch and informers work today.

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

### Watch

A watch is an async iterator of change events. `watch` is a single connection,
which the server closes after a while:

```ts
const list = await configMaps.list({ namespace: "default" });

for await (const event of configMaps.watch({
  namespace: "default",
  resourceVersion: list.metadata?.resourceVersion,
})) {
  if (event.type === "BOOKMARK") continue; // progress marker, no change
  console.log(event.type, event.object.metadata?.name); // ADDED, MODIFIED or DELETED
}
```

`watchWithReconnect` keeps going: when a connection closes or fails it connects
again from the last version it saw, waiting longer after repeated failures. It
only ends by throwing, either because `signal` aborted or because the server
gave an answer that retrying cannot change. The one to expect is 410 Gone: the
version to resume from is too old, and the caller has to list again.

```ts
const stop = new AbortController();
try {
  for await (const event of configMaps.watchWithReconnect({
    namespace: "default",
    resourceVersion: list.metadata?.resourceVersion,
    idleTimeoutMs: 120_000, // reconnect if the connection goes silent
    signal: stop.signal,
  })) {
    // ...
  }
} catch (error) {
  if (isGone(error)) {
    // list again, then watch from the new resourceVersion
  }
}
```

Leaving the loop or aborting `signal` closes the connection.

### Informers

An informer keeps a local copy of a set of objects up to date and tells you
what changed. It lists the objects, watches from there, and lists again by
itself whenever the watch cannot be resumed.

```ts
const informer = configMaps.informer({ namespace: "default", labelSelector: "app=web" });

informer.on("add", (object) => {});
informer.on("update", (object, previous) => {});
informer.on("delete", (object) => {});
informer.on("error", (error) => console.warn(error)); // it keeps trying by itself

await informer.start(); // resolves once the first list is in the local copy

informer.list(); // every object, without a request
informer.get("settings", "default");

informer.stop();
```

Things to know:

- Register listeners before `start()`: the objects of the first list are
  reported as `add`.
- You see every object's latest state, but not necessarily every intermediate
  one. After the informer had to list again, several changes to an object
  arrive as a single `update`.
- Errors do not stop an informer. It reports them and tries again with
  increasing delays, so `start()` stays pending while the first list keeps
  failing, for example for lack of permission. Call `stop()` to give up.
- Each request asks for the token again, and watch connections are renewed
  every five to ten minutes, so a refreshed token is picked up without
  restarting the informer.
- Objects in a list come without `apiVersion` and `kind`; the API server only
  sets them on single objects and watch events.

## Connections that fail

Watches and informers are built to run for hours in a tab, across network
changes, a sleeping laptop and API server restarts.

- **A lost connection** fails the open watch in Chromium and Firefox, and the
  watch reconnects with increasing delays (`backoff`).
- **A connection that died unnoticed** is the case to plan for: after the
  machine slept, and in WebKit even after an API server restart, the browser
  keeps the watch open although nothing will ever arrive. With
  `timeoutSeconds` set, the server ends every watch by itself, so a watch
  still open 30 seconds past that (`closeGraceMs`) is given up and replaced.
  Informers always set it (`watchTimeoutSeconds`, five to ten minutes by
  default). To find out sooner, set `idleTimeoutMs`; the API server normally
  sends a bookmark about once a minute.
- **Background tabs** have their timers slowed down by the browser, to once a
  minute after a while. Events still arrive as they happen; only the delays
  above get longer.
- **Many watches** are fine. The API server speaks HTTP/2, so they share one
  connection instead of running into the browser's limit of six per host. A
  proxy in front of the API server has to speak HTTP/2 to the browser as well.

## Browser support

The end-to-end tests run in Chromium, Firefox and WebKit, including an API
server restart and a token that stops working.

One difference shows in WebKit, at least in the Linux build the tests use: a
request the API server does not authenticate (no token, or one it rejects)
fails with the browser's network error instead of an `ApiError` with status
401 or 403. An informer treats both the same way: it reports the error, keeps
trying, and carries on once the token function returns a valid token.

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

End-to-end tests run in Chromium, Firefox and WebKit against a local
[kind](https://kind.sigs.k8s.io/) cluster:

```sh
pnpm e2e:up      # create the cluster and the test identity
pnpm test:e2e
pnpm test:e2e:faults   # restarts the API server and revokes a token
pnpm e2e:down
```

### Dev container

The repository includes a [dev container](https://containers.dev/) with
everything the commands above need: Node, pnpm, kind, kubectl, and the three
browsers with their system libraries. It is the same Ubuntu release and the same kind and
kubectl versions as CI. The only requirement on the host is Docker.

Open the folder in VS Code and run **Dev Containers: Reopen in Container**, or
use the [Dev Containers CLI](https://github.com/devcontainers/cli):

```sh
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bash
```

Creating the container installs the dependencies and the browsers. After that,
`pnpm e2e:up && pnpm test:e2e` works inside it.

Things to know:

- The container runs its own Docker daemon (docker-in-docker), and kind creates
  the cluster inside it. The cluster is not visible to Docker on the host and
  goes away with the container. This requires a privileged container, so treat
  it as a way to keep tools off the host, not as a security boundary.
- `node_modules` inside the container is a separate volume, because native
  dependencies differ between the host and Linux. Run `pnpm install` on each
  side you work on.
- [Claude Code](https://code.claude.com/docs/en/devcontainer) is installed in
  the container. Run `claude` in a container terminal and sign in once; the
  sign-in is kept in a volume across rebuilds.
- Open the main checkout, not a `git worktree`. A worktree's `.git` file points
  at a host path that does not exist in the container, so Git does not work
  there.

### Without the dev container

Install Node (see `.node-version`), pnpm, Docker, kind and kubectl on the host,
then install the browsers once with
`pnpm exec playwright install chromium firefox webkit`.

## Disclaimer

This is an unofficial project. It is not affiliated with or endorsed by the
Kubernetes project or the Linux Foundation.

## License

[Apache License 2.0](LICENSE)
