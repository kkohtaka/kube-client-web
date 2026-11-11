#!/usr/bin/env bash
# Creates the kind cluster used by the browser e2e tests, if it does not exist,
# and applies the test identity. Safe to run repeatedly.
set -euo pipefail

cd "$(dirname "$0")"

name=kube-client-web
context="kind-${name}"

if ! kind get clusters | grep -qx "${name}"; then
  kind create cluster --config kind-config.yaml --wait 120s
fi

kubectl --context "${context}" apply -f rbac.yaml
kubectl --context "${context}" -n kube-system wait pod --all --for=condition=Ready --timeout=180s
