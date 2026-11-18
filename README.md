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
- A page in a background tab needs no special care; see
  [In a background tab](#in-a-background-tab).
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

### Logs

`log` reads the log of a pod's container as it is now. `followLog` keeps
reading as the log grows and yields it line by line:

```ts
const text = await pods.log("web-0", { namespace: "default", tailLines: 100 });

const stop = new AbortController();
for await (const line of pods.followLog("web-0", {
  namespace: "default",
  container: "app", // needed when the pod has several
  tailLines: 10, // start with the last ten lines
  signal: stop.signal,
})) {
  console.log(line);
}
// The container has stopped.
```

Both take the options of the API: `container`, `previous`, `tailLines`,
`sinceSeconds`, `sinceTime`, `timestamps` and `limitBytes`.

Following ends when the container stops, and by leaving the loop or aborting
`signal`. It throws when the connection is lost, and does not connect again
by itself: a log can only be resumed by time, not by position. To carry on,
ask for `timestamps` and start again with `sinceTime` set to the time of the
last line you saw; the lines of that moment arrive a second time. A log can be
silent for long, so a connection that died without a sign is not noticed.

A log that cannot be read yet, such as that of a container still starting, is
an `ApiError` with status 400.

### Scale, status and other subresources

`getScale` and `scale` read and set the number of replicas of anything that
can be scaled: deployments, stateful sets, replica sets, and custom resources
that declare a `scale` subresource.

```ts
const scale = await deployments.getScale("web", { namespace: "default" });
scale.spec?.replicas; // wanted; left out by the server when zero
scale.status?.replicas; // there now

await deployments.scale("web", 5, { namespace: "default" });
```

Setting the replicas this way needs permission for `deployments/scale` only,
not for the deployment itself.

For `status`, `get`, `update`, `patch` and `apply` take
`subresource: "status"`; the object keeps its type:

```ts
await widgets.patch("w1", { status: { ready: true } }, { namespace, subresource: "status" });
```

Any other subresource is reached with `subresource()`, which offers `get`,
`create`, `update` and `patch` on it. `create` posts to it, which is how an
eviction is requested:

```ts
await pods.subresource("web-0", "eviction", { namespace: "default" }).create({
  apiVersion: "policy/v1",
  kind: "Eviction",
  metadata: { name: "web-0", namespace: "default" },
});
```

`exec`, `attach` and `portforward` are not supported: they need WebSockets.

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
- To renew the session, the provider has to answer a refresh token with a new
  ID token. Dex and Keycloak do. OpenID Connect allows an answer without one;
  with such a provider the session ends when the ID token expires, and
  `auth.token` throws a `SignInRequiredError` that says so.
- When renewing fails for a passing reason, such as the network or an error
  at the provider, `auth.token` keeps supplying the current token until it
  expires, and tries again on the next call.
- When there is no session, or it cannot be renewed any more, `auth.token`
  throws a `SignInRequiredError`. Requests then fail with it, and informers
  report it as an `error` event and keep trying; call `auth.signIn()` when you
  see it.
  The session cannot be renewed any more once the provider refuses its refresh
  token: with `invalid_grant`, or with any other error that the token endpoint
  reports with status 400 or 401. Providers differ in the error they name.
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

[`examples/demo`](examples/demo) is a page that signs in with OpenID Connect
and draws a live map of a cluster: namespaces, their deployments and every
pod, appearing and disappearing as the cluster changes. Choosing a pod shows
its log as it grows. See its README for how to run it against a local kind
cluster.

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
- **Background tabs** get less time to run, down to none at all. See
  [In a background tab](#in-a-background-tab).
- **Many watches** are fine. The API server speaks HTTP/2, so they share one
  connection instead of running into the browser's limit of six per host. A
  proxy in front of the API server has to speak HTTP/2 to the browser as well.

### In a background tab

Browsers save power on pages nobody looks at, each in its own way. What the
demo showed in a hidden tab on macOS, in November 2026:

|         | Changes while hidden           | Timers while hidden                                |
| ------- | ------------------------------ | -------------------------------------------------- |
| Chrome  | reported as they happen        | slowed down, to once a minute after about a minute |
| Firefox | reported as they happen        | hardly slowed down                                 |
| Safari  | reported when the user returns | stopped after about ten seconds                    |

Safari stops the page of a hidden tab altogether, for as long as the tab
stays hidden; twelve minutes in the longest check. Chrome may also freeze a
page, so that it does not run until the user returns, or discard it, after
which it loads anew. Phones do all of this sooner than desktops.

A watch or an informer needs no care from the page to get through this:

- **While the page still runs**, changes are reported as they arrive; only
  timers are slowed down, not the network. What gets longer are the delays
  that the library measures with timers: the waits between attempts after a
  failure, and the time it takes to give up a connection that died unnoticed.
  A watch that the server ends is replaced as usual, and a token that runs
  out is renewed.
- **While the page does not run**, nothing is reported. When it runs again,
  the informer first reports what the open connection had received. If the
  server ended the watch in the meantime, it connects again from the last
  version it saw, with the token current at that moment, and reports what it
  missed. If that version is too old by then, which takes the API server a
  few minutes, it lists again and reports the differences. Either way
  listeners are told about every object's latest state, though not about
  every state in between. The deadlines of a watch have passed by then; the
  page gets two seconds to read what its connection holds before the watch
  is given up, so that a pause alone is not reported as an error.
- **A token that ran out meanwhile** is no obstacle. `auth.token` does not
  renew tokens on a timer but when a request needs one, so the first request
  after a long pause renews it. If the session cannot be renewed any more,
  the informer reports the `SignInRequiredError` and keeps trying.
- **When the page becomes visible again** after it was hidden for at least ten
  seconds, watches and informers do not trust their connection: they replace
  it right away, from the last version they saw, and retry at once if they
  were waiting after a failure. So a page shows the current state a moment
  after the user returns to it, also when the connection died unnoticed while
  the machine slept. This costs one request per watch and loses nothing. Set
  `reconnectAfterHiddenMs` to change the ten seconds, or to `Infinity` to
  leave connections alone.

A page that acts on changes while it is hidden, for example to show a
notification, cannot count on hearing of them before the user returns: in
Safari it does not, and elsewhere only until the browser freezes the page.

## Browser support

The end-to-end tests run in Chromium, Firefox and WebKit, including an API
server restart and a token that stops working.

Background tabs are covered by the tests as far as the test browsers allow.
Driven by Playwright, none of them puts a page in the background: a page
behind another one stays visible, with timers at full pace. In Chromium so
does a page in a minimized window, and it is not frozen when asked to through
the DevTools protocol. So the tests emulate two things, in all three browsers.
They make the page look hidden to scripts and back, which shows what the
library does on `visibilitychange`. And they keep the page from running for a
few seconds, longer than a watch lasts and than the page takes its token for
valid, by keeping its thread busy; to the page's scripts that is what being
frozen amounts to.

What the tests cannot show was checked by hand with the demo, in Chrome,
Firefox and Safari on macOS, in November 2026. In each of them a tab was
hidden for more than eleven minutes, longer than a watch and the ID token
last, while namespaces were created. A first round found two faults that have
since been fixed: an error reported on return in Safari, and a session that a
provider refused to renew but that was not ended. In the round after that no
change was lost, no error was reported, the token was renewed with one
request, and on return the watches were replaced from the version they had
reached. A tab that returned within
ten seconds kept its connections. In Chrome the same held for a page frozen
through `chrome://discards` and after the machine had slept; there Chrome
fails the open watches itself when the machine goes to sleep, so the informer
knows at once.

Not checked anywhere: sleep in Firefox and Safari, a page the browser
discarded, phones, and pauses so long that the version a watch had reached is
gone. The demo reaches the API server through a development server over
HTTP/1.1; a page that talks to the API server directly was not checked by
hand.

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

A change to the dev container, such as an update of a feature, needs a green
run of the `Dev container` workflow and nothing else: it does not have to be
rebuilt on someone's machine first. The workflow runs for every push that
changes the container, and weekly. On amd64 and on arm64 (what Docker builds
on Apple Silicon), it

- creates the container from scratch with the commands above;
- checks as the container's user that `node`, `pnpm` and `claude` start from a
  login shell, a script and a terminal, in the versions of `.node-version` and
  `package.json`; that Claude Code's configuration directory is writable; and
  that the dependencies and the browsers are installed
  (`.devcontainer/check-container.sh`);
- runs the e2e, OpenID Connect, demo and fault tests in it;
- creates the container from the commit before the change, starts the cluster
  in it, then creates it again from the change over the same volumes, as a
  machine that already had the container does, and repeats the checks and the
  e2e tests. The volume with the Claude Code sign-in has to keep a file.

It also checks that the digests in `.devcontainer/devcontainer-lock.json` are
the ones the registry serves for the versions named there
(`.devcontainer/check-lockfile.sh`).

Not covered: signing in to Claude Code, VS Code and its extensions, and Docker
Desktop on macOS.

### Without the dev container

Install Node (see `.node-version`), pnpm, Docker, kind and kubectl on the host,
then install the browsers once with
`pnpm exec playwright install chromium firefox webkit`.

### Proposing a change

[CLAUDE.md](CLAUDE.md) says how a change is checked before it becomes a pull
request, and which paths get a full read; [REVIEW.md](REVIEW.md) says what a
review looks for. Both hold for people as much as for agents.

A pull request may change at most 600 lines, not counting lockfiles, the
changelog and changesets. The `Pull request size` workflow checks this. For a
change that cannot be split, a maintainer adds the `large-change` label.

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
