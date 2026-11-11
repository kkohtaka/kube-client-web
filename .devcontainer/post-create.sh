#!/usr/bin/env bash
# Runs once after the dev container is created: installs dependencies and the
# browser used by the e2e tests, the same way CI does.
set -euo pipefail

cd "$(dirname "$0")/.."

# Named volumes are created owned by root.
sudo chown "$(id -u):$(id -g)" node_modules "${HOME}/.claude"

pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
