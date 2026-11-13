---
"kube-client-web": minor
---

Add `createOidcAuth`: signs the user in with an OpenID Connect provider (authorization code flow with PKCE) and supplies the ID token to the client, renewing it with a refresh token when the provider issues one.
