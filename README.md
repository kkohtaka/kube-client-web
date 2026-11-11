# kube-client-web

A Kubernetes client library for the browser, with informer support.

> **Status:** early development. Nothing is published yet and the API is not stable.

## Goals

- Talk to a Kubernetes API server directly from the browser using `fetch`.
- Provide informers (list + watch with a local cache), not just REST calls.
- Ship as ESM with TypeScript types.

## Development

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

End-to-end tests run in Chromium against a local [kind](https://kind.sigs.k8s.io/) cluster:

```sh
pnpm e2e:up      # create the cluster and the test identity
pnpm test:e2e
pnpm e2e:down
```

### Dev container

The repository includes a [dev container](https://containers.dev/) with
everything the commands above need: Node, pnpm, kind, kubectl, and Chromium
with its system libraries. It is the same Ubuntu release and the same kind and
kubectl versions as CI. The only requirement on the host is Docker.

Open the folder in VS Code and run **Dev Containers: Reopen in Container**, or
use the [Dev Containers CLI](https://github.com/devcontainers/cli):

```sh
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bash
```

Creating the container installs the dependencies and Chromium. After that,
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
then install the browser once with `pnpm exec playwright install chromium`.

## Disclaimer

This is an unofficial project. It is not affiliated with or endorsed by the
Kubernetes project or the Linux Foundation.

## License

[Apache License 2.0](LICENSE)
