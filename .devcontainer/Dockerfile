# Ubuntu 26.04 is what GitHub Actions' ubuntu-latest runs, so the e2e tests see
# the same distribution and browser dependencies locally and in CI.
FROM mcr.microsoft.com/devcontainers/base:ubuntu26.04

# Same versions as the ubuntu-26.04 runner image, pinned by checksum.
# TARGETARCH is amd64 or arm64 (Apple Silicon).
ARG TARGETARCH
ARG KIND_VERSION=v0.33.0
ARG KIND_SHA256_AMD64=aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d
ARG KIND_SHA256_ARM64=20022bee6cfcd5086cb7234d218e3454e6090022f2a8f55d1fa7fcf42c3867a2
ARG KUBECTL_VERSION=v1.37.2
ARG KUBECTL_SHA256_AMD64=c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4
ARG KUBECTL_SHA256_ARM64=fcc16f63186659d9722014b7e02d5fdd2d4e669cb8c0ab66365d7d3b8ba03509

RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) kind_sha="${KIND_SHA256_AMD64}"; kubectl_sha="${KUBECTL_SHA256_AMD64}" ;; \
      arm64) kind_sha="${KIND_SHA256_ARM64}"; kubectl_sha="${KUBECTL_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/kind \
      "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-linux-${TARGETARCH}"; \
    echo "${kind_sha}  /usr/local/bin/kind" | sha256sum -c -; \
    curl -fsSL -o /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl"; \
    echo "${kubectl_sha}  /usr/local/bin/kubectl" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/kind /usr/local/bin/kubectl
