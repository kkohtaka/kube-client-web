# Demo

A page that lists the ConfigMaps of one namespace, or the Pods of the whole
cluster, and keeps the list up to date with an informer. It is about 250 lines
of plain TypeScript without a framework, in [`main.ts`](main.ts).

## Running it

From the repository root, with Docker, kind and kubectl available (the
[dev container](../../README.md#dev-container) has them):

```sh
pnpm install
pnpm e2e:up   # create the kind cluster the demo talks to
pnpm demo     # then open the address it prints
```

Then change something and watch the page follow:

```sh
kubectl --context kind-kube-client-web -n kube-client-web-e2e create configmap hello --from-literal=a=1
kubectl --context kind-kube-client-web -n kube-client-web-e2e delete configmap hello
```

The buttons on the page create and delete ConfigMaps through the library as
well. `pnpm e2e:down` removes the cluster.

## What to look at

- **The informer is the model.** The page never keeps its own list. After
  every `add`, `update` or `delete` it draws `informer.list()` again.
- **Tokens.** The client is given a function, `currentToken`, which it calls
  before every request. The function fetches a new token shortly before the
  old one expires, so the page keeps working past the lifetime of one token.
- **Errors.** The `error` listener only updates the status line. Reconnecting
  is the informer's job. Stop the cluster's container for a moment to see it.

## How the demo differs from a real deployment

To run with one command, the demo takes two shortcuts in
[`vite.config.ts`](vite.config.ts). Neither belongs in an application.

- **The dev server forwards `/k8s` to the API server.** That saves you from
  making the browser trust kind's certificate. A deployed page talks to the
  API server directly, which needs a certificate the browser trusts and
  `--cors-allowed-origins`; see
  [Cluster requirements](../../README.md#cluster-requirements). It also means
  the browser speaks HTTP/1.1 here, with its limit of six connections, so the
  demo follows one resource at a time.
- **The dev server hands out tokens at `/token`,** minted with `kubectl` for a
  test identity. In an application the token comes from your identity
  provider, typically through OIDC.
