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

The page only offers to change what it created itself. `pnpm e2e:down` removes
the cluster.

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
  connections, of which the three watches hold three.
- **The provider knows one user with a well-known password,** and that user
  may create and delete namespaces and deployments anywhere in the cluster
  ([`e2e/dex.yaml`](../../e2e/dex.yaml), [`e2e/rbac.yaml`](../../e2e/rbac.yaml)).
  The cluster only listens on `127.0.0.1`.
