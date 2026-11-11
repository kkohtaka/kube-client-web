#!/usr/bin/env bash
# Runs once after the dev container is created: installs dependencies and the
# browser used by the e2e tests, the same way CI does.
set -euo pipefail

cd "$(dirname "$0")/.."

# Named volumes are created owned by root.
sudo chown "$(id -u):$(id -g)" node_modules "${HOME}/.claude"

pnpm install --frozen-lockfile

# The container's Docker daemon starts in the background and may still be
# coming up. Wait for it so that `pnpm e2e:up` works right after creation.
if ! timeout 60 sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done'; then
  echo "The Docker daemon in the dev container did not start. Its log:" >&2
  cat /tmp/dockerd.log >&2 || true
  exit 1
fi

# The daemon's data lives in a volume that outlives the container, but the
# kubeconfig does not. Remove clusters left behind by a previous container so
# that `pnpm e2e:up` starts from a clean state.
kind delete clusters --all

pnpm exec playwright install --with-deps chromium firefox webkit
