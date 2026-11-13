#!/usr/bin/env bash
# Creates the kind cluster used by the browser e2e tests, if it does not exist,
# and applies the test fixtures. Safe to run repeatedly.
set -euo pipefail

cd "$(dirname "$0")"

name=kube-client-web
context="kind-${name}"
issuer=https://127.0.0.1:5556/dex

# The API server only starts with the CA of the OpenID Connect provider in
# place, so it is made before the cluster. It is kept for the next cluster.
if [ ! -f .oidc/tls.crt ]; then
  mkdir -p .oidc
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj "/CN=kube-client-web e2e CA" \
    -keyout .oidc/ca.key -out .oidc/ca.crt 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=dex" \
    -keyout .oidc/tls.key -out .oidc/tls.csr 2>/dev/null
  openssl x509 -req -in .oidc/tls.csr -days 3650 \
    -CA .oidc/ca.crt -CAkey .oidc/ca.key -CAcreateserial \
    -extfile <(printf 'subjectAltName=IP:127.0.0.1,DNS:localhost') \
    -out .oidc/tls.crt 2>/dev/null
fi

if ! kind get clusters | grep -qx "${name}"; then
  kind create cluster --config kind-config.yaml --wait 120s
fi

if ! kubectl --context "${context}" -n kube-system get pods -l component=kube-apiserver -o yaml |
  grep -q -- "--oidc-issuer-url=${issuer}"; then
  echo "The cluster was created before the tests needed OpenID Connect." >&2
  echo "Run 'pnpm e2e:down' and then 'pnpm e2e:up' again." >&2
  exit 1
fi

kubectl --context "${context}" apply -f crd.yaml -f rbac.yaml
kubectl --context "${context}" wait crd/widgets.e2e.kube-client-web.test --for=condition=Established --timeout=60s
kubectl --context "${context}" -n kube-system wait pod --all --for=condition=Ready --timeout=180s

kubectl --context "${context}" create namespace dex --dry-run=client -o yaml |
  kubectl --context "${context}" apply -f -
kubectl --context "${context}" -n dex create secret tls dex-tls \
  --cert=.oidc/tls.crt --key=.oidc/tls.key --dry-run=client -o yaml |
  kubectl --context "${context}" apply -f -
kubectl --context "${context}" apply -f dex.yaml
kubectl --context "${context}" -n dex rollout status deployment/dex --timeout=180s

# The API server looks for the provider again every few seconds until it finds
# it. Wait until it accepts a token, so that the tests do not have to.
echo "Waiting for the API server to accept tokens from ${issuer}"
for attempt in $(seq 1 60); do
  token="$(curl -fsS --cacert .oidc/ca.crt "${issuer}/token" \
    -d grant_type=password -d client_id=kube-client-web \
    -d username=jane@example.com -d password=password \
    --data-urlencode "scope=openid email" 2>/dev/null |
    sed -n 's/.*"id_token":"\([^"]*\)".*/\1/p' || true)"
  if [ -n "${token}" ]; then
    status="$(curl -sk -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer ${token}" https://127.0.0.1:6443/version || true)"
    if [ "${status}" = 200 ]; then
      exit 0
    fi
  fi
  sleep 2
done
echo "The API server does not accept tokens from ${issuer} (last status: ${status:-no token})." >&2
kubectl --context "${context}" -n dex logs deployment/dex --tail=50 >&2 || true
exit 1
