# kube-client-web

## 0.2.0

### Minor Changes

- 6d7605a: Add `createOidcAuth`: signs the user in with an OpenID Connect provider (authorization code flow with PKCE) and supplies the ID token to the client, renewing it with a refresh token when the provider issues one.
- 7d6193c: Add shared informers. `client.sharedInformers()` returns a factory whose informers for the same resource, namespace and selectors are served by one list and watch, so several parts of a page can follow the same objects without each listing and watching them.

## 0.1.0

### Minor Changes

- 7efaef5: Initial release. A Kubernetes client for the browser: typed REST operations for any resource, watch with automatic reconnect, and informers that keep a local copy of a set of objects up to date.
