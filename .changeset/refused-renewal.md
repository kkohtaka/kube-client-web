---
"kube-client-web": patch
---

`auth.token` now throws a `SignInRequiredError` whenever the provider refuses to renew the session, not only when it says `invalid_grant`. Providers name other errors as well: Dex answers `invalid_request` for a refresh token that was replaced by a later sign-in. Such a refusal used to count as a passing failure, so that informers asked the provider again and again and the page was never told to sign in. `OidcError` has a new `status` property with the HTTP status of the provider's answer.
