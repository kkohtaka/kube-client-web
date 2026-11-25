# Demo

A page that signs you in with OpenID Connect and then draws a live map of a
cluster. Every namespace is a region, every deployment a box in it, and every
pod a small shape whose outline and fill show its state. Create a namespace,
add a deployment, scale it: the shapes appear, change and go as the cluster
does. It is plain TypeScript without a framework, in [`main.ts`](main.ts).

## Running it

From the repository root, with Docker, kind and kubectl available (the
[dev container](../../README.md#dev-container) has them):

```sh
pnpm install
pnpm e2e:up   # create the kind cluster the demo talks to
pnpm demo     # then open the address it prints, on localhost
```

Choose **Sign in**. The browser goes to the cluster's OpenID Connect provider,
[Dex](https://dexidp.io/), at `https://127.0.0.1:5556`. Its certificate is
made for this cluster only, so the browser warns once; continue to the page.
Sign in as `jane@example.com` with the password `password`.

Then change something, on the page or from a terminal, and watch the map
follow:

```sh
kubectl --context kind-kube-client-web create namespace hello
kubectl --context kind-kube-client-web -n hello create deployment web --image=registry.k8s.io/pause:3.10 --replicas=4
kubectl --context kind-kube-client-web -n hello scale deployment web --replicas=1
kubectl --context kind-kube-client-web delete namespace hello
```

The page only offers to change what it created itself, and the cluster lets
its user change nothing else: see
[What the user may change](#what-the-user-may-change). `pnpm e2e:down` removes
the cluster.

Keep the demo to one tab. Each tab holds three watches, and all tabs and
windows of a browser share the six connections it opens to the development
server (see
[How the demo differs from a real deployment](#how-the-demo-differs-from-a-real-deployment)).
With two tabs every connection is held by a watch, and every other request,
to the cluster or to the provider, waits until one comes free. The buttons
that create, scale and delete seem to do nothing, a pod's log does not start,
and even loading another page from the same address hangs. The page does not
say why, and a tab that already showed the map keeps the status "Live". A
watch lasts five to ten minutes, so the wait can be that long. The requests
are not lost: they are sent as soon as a connection is free, for one when
the other tab is closed, so a button pressed three times while nothing
happened takes effect three times.

## What to look at

- **Signing in.** `createOidcAuth` does the whole exchange with the provider.
  The page calls `completeSignIn()` when it loads, `signIn()` from the button,
  and gives `auth.token` to the client. The token is renewed in the
  background; when the session cannot be renewed any more, requests fail with
  `SignInRequiredError` and the page goes back to the sign-in view.
- **The informers are the model.** The page keeps no list of its own. Three
  shared informers follow namespaces, deployments and pods; after every `add`,
  `update` or `delete` the map is drawn again from their `list()`.
- **Drawing changes.** `sync()` keeps the element of every object that stays,
  so only new shapes run their arrival animation and only removed ones leave.
- **Scaling.** The − and + buttons use `scale()`, which changes the number of
  replicas through the deployment's `scale` subresource. The demo's user may
  do that and nothing else to a deployment once it exists.
- **Logs.** Choosing a pod on the map shows the last lines of its log and
  follows it with `followLog()`. The pods of the control plane in
  `kube-system` have something to say; the ones the page creates run a
  container that writes nothing.
- **Errors.** The `error` listener only updates the status line. Reconnecting
  is the informer's job. Stop the cluster's container for a moment to see it.

## How the demo differs from a real deployment

To run with one command, the demo takes shortcuts. None belongs in an
application.

- **The dev server forwards `/k8s` to the API server and `/idp` to the
  provider** ([`vite.config.ts`](vite.config.ts)). That saves you from making
  the browser trust two certificates. A deployed page talks to both directly,
  which needs certificates the browser trusts and cross-origin requests
  allowed on both; see
  [Cluster requirements](../../README.md#cluster-requirements) and
  [Signing in with OpenID Connect](../../README.md#signing-in-with-openid-connect).
  It also means the browser speaks HTTP/1.1 here, with its limit of six
  connections, of which the three watches hold three and a log that is
  followed a fourth. What happens when they run out is under
  [Running it](#running-it); for a deployed page, see "Many watches" under
  [Connections that fail](../../README.md#connections-that-fail).
- **The dev server holds back the answer to a watch until the watch has
  something to report.** Asked directly, the API server of the kind cluster
  answers a watch at once, with status 200 and headers, and then sends events
  as they happen. Through the dev server the status and headers only arrive
  together with the first event, which on a resource that does not change is
  the bookmark the API server sends about once a minute. So the browser's
  network panel shows a watch as pending for about a minute although it is
  open and misses nothing. This was measured with `curl` in November 2026,
  with Vite 8.3. The demo sets no `idleTimeoutMs`. A page that does, behind a
  proxy that behaves like this, has to leave room for more than one bookmark,
  as the two minutes in the
  [example for `watchWithReconnect`](../../README.md#watch) do: the wait
  for the answer counts as silence too.
- **The provider knows one user with a well-known password**
  ([`e2e/dex.yaml`](../../e2e/dex.yaml)). The cluster only listens on
  `127.0.0.1`.
- **That user may read everything in the cluster,** secrets excepted. A page
  for real users shows them what they need.

## What the user may change

A page that changes a cluster should be able to change no more than it offers
to. Roles alone cannot say that here: the demo makes its own namespaces, and a
role cannot be limited to "the namespaces this page made". So
[`e2e/rbac.yaml`](../../e2e/rbac.yaml) does it in two steps.

- A `ClusterRole` lets the user create and delete namespaces and deployments,
  and scale deployments, anywhere.
- A `ValidatingAdmissionPolicy` then refuses those requests unless they are
  about the demo's own objects, which carry the label
  `app.kubernetes.io/managed-by: kube-client-web-demo`: a namespace with the
  label, or a deployment with the label in such a namespace. Scaling is
  allowed for every deployment in such a namespace, because the `Scale` the
  request carries does not have the deployment's labels.

Creating deployments means running containers, and a container can be asked
to run with the rights of the node. The policy therefore lets the user create
a namespace only if it enforces the `restricted`
[Pod Security Standard](https://kubernetes.io/docs/concepts/security/pod-security-standards/),
and the page asks for that.

[`e2e/oidc/permissions.test.ts`](../../e2e/oidc/permissions.test.ts) checks
what is allowed and what is refused. The policy needs Kubernetes 1.30 or
later.

The two belong together. The role without the policy lets its user delete any
namespace of the cluster; do not copy one without the other.
