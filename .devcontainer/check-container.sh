#!/usr/bin/env bash
# Checks the dev container the way a person uses it, as the remote user: the
# tools are found by every kind of shell, in the versions the project asks for,
# and creating the container ran to the end.
#
# CI runs this with `docker exec`, so it starts from the container's own
# environment, not from one that `devcontainer exec` has already read from a
# login shell.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

failures=0
fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

node_version="$(cat .node-version)"
pnpm_version="$(sed -n 's/.*"packageManager": "pnpm@\([^"+]*\).*/\1/p' package.json)"
stderr="$(mktemp)"

# Runs a command in one kind of shell and leaves its stdout in ${got}.
# bash -i complains that there is no terminal; that is shown only on failure.
# The command runs outside the workspace, where pnpm reports the version that
# is installed and not the one package.json asks for.
run_in() {
  local flags="$1" command="$2"
  if ! got="$(cd / && bash "${flags}" "${command}" 2>"${stderr}")"; then
    fail "bash ${flags} '${command}' failed: $(cat "${stderr}")"
    return 1
  fi
}

# -c: what a script or a tool gets. -lc: a login shell. -ic: a terminal.
for flags in -c -lc -ic; do
  if run_in "${flags}" 'node --version'; then
    case "${got}" in
      "v${node_version}" | "v${node_version}".*) echo "ok: bash ${flags}: node ${got}" ;;
      *) fail "bash ${flags}: node is ${got}, .node-version asks for ${node_version}" ;;
    esac
  fi
  if run_in "${flags}" 'pnpm --version'; then
    if [ "${got}" = "${pnpm_version}" ]; then
      echo "ok: bash ${flags}: pnpm ${got}"
    else
      fail "bash ${flags}: pnpm is ${got}, package.json asks for ${pnpm_version}"
    fi
  fi
  if run_in "${flags}" 'claude --version'; then
    echo "ok: bash ${flags}: claude ${got}"
  fi
done

# Claude Code keeps its sign-in here. The directory is a volume, which Docker
# creates owned by root.
config_dir="${CLAUDE_CONFIG_DIR:-}"
if [ -z "${config_dir}" ]; then
  fail "CLAUDE_CONFIG_DIR is not set"
elif ! touch "${config_dir}/.check-container" 2>"${stderr}"; then
  fail "$(id -un) cannot write to ${config_dir}: $(cat "${stderr}")"
else
  rm -f "${config_dir}/.check-container"
  echo "ok: $(id -un) can write to ${config_dir}"
fi

# post-create.sh installs the dependencies first and the browsers last.
if [ -f node_modules/.modules.yaml ]; then
  echo "ok: dependencies are installed"
else
  fail "node_modules/.modules.yaml is missing: pnpm install did not finish"
fi
if ! node --input-type=commonjs -e '
  const fs = require("node:fs");
  const playwright = require("playwright");
  let missing = 0;
  for (const name of ["chromium", "firefox", "webkit"]) {
    const path = playwright[name].executablePath();
    if (fs.existsSync(path)) {
      console.log(`ok: ${name} is installed at ${path}`);
    } else {
      console.error(`${name} is not installed at ${path}`);
      missing++;
    }
  }
  process.exit(missing);
' 2>"${stderr}"; then
  fail "post-create.sh did not install the browsers: $(cat "${stderr}")"
fi

if ! docker info >/dev/null 2>"${stderr}"; then
  fail "$(id -un) cannot reach the Docker daemon: $(cat "${stderr}")"
else
  echo "ok: $(id -un) can reach the Docker daemon"
fi

rm -f "${stderr}"
if [ "${failures}" -gt 0 ]; then
  echo "${failures} check(s) failed" >&2
  exit 1
fi
