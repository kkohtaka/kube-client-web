# kube-client-web

A Kubernetes client library for the browser, with informer support.

> **Status:** early. The API may still change between minor versions before 1.0.

## Goals

- Talk to a Kubernetes API server directly from the browser using `fetch`.
- Provide informers (list + watch with a local cache), not just REST calls.
- Ship as ESM with TypeScript types and no runtime dependencies.

## Install

```sh
npm install kube-client-web
```

The package is ESM only, ships its TypeScript types and has no dependencies.

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

### Shared informers

When several parts of a page follow the same objects, a shared informer
factory serves them all with one list, one watch and one copy of the objects,
instead of one of each per user.

```ts
const informers = client.sharedInformers();

// Anywhere on the page, as often as needed:
const informer = informers.informer(configMaps, { namespace: "default" });
informer.on("add", (object) => {});
await informer.start();

informer.list();
informer.stop(); // the watch ends when the last user has stopped
```

Each call to `informer()` returns an informer of its own, with the same
methods and events as above. Those for the same resource, namespace and
selectors are served by a single list and watch, which runs while at least one
of them is started.

Things to know:

- An informer started while others are already following the same objects is
  told about every object they know as `add`, and `start()` resolves without
  a request.
- `stop()` ends the events for that informer only. Unlike a plain informer, it
  is told about every object again after it is started again, not about what
  changed in between.
- All users get the same objects, so treat them as read-only.
- Selectors are compared as written: `a=1,b=2` and `b=2,a=1` do not share a
  watch.
- Options such as `pageSize` or `backoff` are given once, to
  `sharedInformers()`, and apply to all its informers.
- `informers.stop()` stops every informer of the factory.

## Signing in with OpenID Connect

When the API server accepts tokens from an OpenID Connect provider,
`createOidcAuth` signs the user in at that provider and supplies the token.

```ts
import { createClient, createOidcAuth, SignInRequiredError } from "kube-client-web";

const auth = createOidcAuth({
  issuer: "https://idp.example.com", // as in the API server's --oidc-issuer-url
  clientId: "my-app", // as in --oidc-client-id
  scopes: ["email", "offline_access"],
});

// On every page load: finishes a sign-in if the browser just came back.
await auth.completeSignIn();

if (!auth.signedIn) {
  await auth.signIn(); // leaves the page for the provider
}

const client = createClient({ baseUrl, token: auth.token });

auth.claims?.email; // for display
auth.signOut();
```

It uses the authorization code flow with PKCE as a public client: there is no
client secret and no server of your own involved. The token given to the API
server is the ID token.

Things to know:

- `auth.token` renews the token shortly before it expires, if the provider
  issued a refresh token. Most providers do so for the `offline_access` scope.
  Without one, the session ends when the ID token expires.
- When there is no session, or it cannot be renewed any more, `auth.token`
  throws a `SignInRequiredError`. Requests then fail with it, and informers
  report it as an `error` event and keep trying; call `auth.signIn()` when you
  see it.
- The session is kept in `sessionStorage`, so it survives a reload and ends
  with the tab. Pass `storage: localStorage` to keep it longer and share it
  between tabs; tabs then take turns renewing it. Either way, a script running
  on your page can read the tokens, as it could with any other way of holding
  them in the browser.
- A token is taken to live as long as it says from the moment it arrives, so
  a wrong clock on the user's device does not end the session early or late.
- `signOut()` forgets the session in this browser. The user stays signed in at
  the provider.
- The ID token's issuer, audience, nonce and expiry are checked. Its signature
  is not: the token comes straight from the provider over TLS, and the API
  server checks the signature of every token it is given.

The provider has to cooperate, like the cluster:

- The client is registered as a public client with PKCE, with your page as a
  redirect URI. By default that is the page that calls `signIn()`, without
  query and fragment; set `redirectUri` to use another one.
- The provider's configuration and token endpoints allow cross-origin requests
  from your page.
- The page is served over HTTPS or from localhost. Browsers offer the
  cryptography PKCE needs nowhere else.

[`e2e/dex.yaml`](e2e/dex.yaml) and [`e2e/kind-config.yaml`](e2e/kind-config.yaml)
show a working setup with [Dex](https://dexidp.io/).

## Demo

[`examples/demo`](examples/demo) is a small page that shows a live view of a
cluster with an informer. See its README for how to run it against a local
kind cluster.

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
  kubeconfig exec plugins are not available to a web page. See
  [Signing in with OpenID Connect](#signing-in-with-openid-connect) for one
  way to get a token.
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
pnpm test:oidc         # signs in through Dex, which runs in the cluster
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

### Releasing

Releases are driven by [Changesets](https://changesets.dev/).

- A pull request that changes what users of the package get adds a changeset:
  run `pnpm changeset`, pick the kind of change and describe it in a sentence
  for the changelog. Changes to tests, CI or the demo need none.
- While changesets are waiting on `main`, the Release workflow keeps a
  "Version Packages" pull request up to date. It bumps the version and moves
  the changesets into `CHANGELOG.md`.
- Merging that pull request publishes the new version to npm, tags it and
  creates a GitHub release.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers):
the package on npmjs.com names this repository and `release.yml` as its
trusted publisher, so no token is stored anywhere.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Disclaimer

This is an unofficial project. It is not affiliated with or endorsed by the
Kubernetes project or the Linux Foundation.

## License

[Apache License 2.0](LICENSE)
