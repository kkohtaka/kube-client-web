#!/usr/bin/env bash
# Checks devcontainer-lock.json against the registry: every feature of
# devcontainer.json has an entry, and the digest of each entry is the one the
# registry serves for the version the entry names.
#
# Runs on the host and needs the Dev Containers CLI and jq.
set -euo pipefail

cd "$(dirname "$0")/.."

lock=.devcontainer/devcontainer-lock.json
failures=0
fail() {
  echo "::error file=${lock}::$*"
  failures=$((failures + 1))
}

configured="$(devcontainer read-configuration --workspace-folder . |
  jq -r '.configuration.features | keys[]' | sort)"
locked="$(jq -r '.features | keys[]' "${lock}" | sort)"
if [ "${configured}" != "${locked}" ]; then
  fail "the features in the lockfile are not the features in devcontainer.json"
fi

while IFS=$'\t' read -r id version resolved integrity; do
  # ghcr.io/owner/features/name:1 -> ghcr.io/owner/features/name:1.2.3
  ref="${id%:*}:${version}"
  if ! served="$(devcontainer features info manifest "${ref}" --output-format json |
    jq -er .canonicalId)"; then
    fail "${ref} was not found in the registry"
    continue
  fi
  if [ "${resolved}" != "${served}" ]; then
    fail "${id}: \"resolved\" is ${resolved}, the registry serves ${served}"
  elif [ "${integrity}" != "${served##*@}" ]; then
    fail "${id}: \"integrity\" is ${integrity}, the registry serves ${served##*@}"
  else
    echo "ok: ${ref} is ${served##*@}"
  fi
done < <(jq -r '.features | to_entries[] | [.key, .value.version, .value.resolved, .value.integrity] | @tsv' "${lock}")

if [ "${failures}" -gt 0 ]; then
  exit 1
fi
