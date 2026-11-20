# kube-client-web

## 0.3.0

### Minor Changes

- 9fe2c8e: Informers and `watchWithReconnect` replace their watch connection as soon as the page becomes visible again after it was hidden for a while, and retry at once if they were waiting after a failure. A connection that died unnoticed in a background tab or while the machine slept no longer leaves the page with old data until the next deadline. The new option `reconnectAfterHiddenMs` sets how long the page must have been hidden, ten seconds by default; `Infinity` switches this off.
- 5d31781: Add pod logs and subresources. `log()` reads the log of a pod's container and `followLog()` follows it line by line as it grows. `getScale()` and `scale()` read and set the replicas of anything with a scale subresource. `subresource()` reaches any other subresource of an object, such as `eviction`.

### Patch Changes

- 8191075: A watch no longer gives up on its connection the moment a page runs again after it did not run for a while, in a background tab or while the machine slept. The deadlines of `timeoutSeconds` and `idleTimeoutMs` had passed by then, but nothing the server sent could be read in the meantime either. The page now first gets two seconds to read what the connection holds. Safari stops the pages of background tabs within seconds, so informers there reported "the server did not end the watch when it was due" on every return to the tab.
- 03bd060: `auth.token` keeps supplying the current ID token while it is valid when renewing it fails for a passing reason, such as a network error, instead of failing. A provider that renews a session without a new ID token no longer loses the new refresh token; the session ends with a `SignInRequiredError` that names the cause once the ID token expires.
- 0709aec: `auth.token` now throws a `SignInRequiredError` whenever the provider refuses to renew the session, not only when it says `invalid_grant`. Providers name other errors as well: Dex answers `invalid_request` for a refresh token that was replaced by a later sign-in. Such a refusal used to count as a passing failure, so that informers asked the provider again and again and the page was never told to sign in. `OidcError` has a new `status` property with the HTTP status of the provider's answer.

## 0.2.0

### Minor Changes

- 6d7605a: Add `createOidcAuth`: signs the user in with an OpenID Connect provider (authorization code flow with PKCE) and supplies the ID token to the client, renewing it with a refresh token when the provider issues one.
- 7d6193c: Add shared informers. `client.sharedInformers()` returns a factory whose informers for the same resource, namespace and selectors are served by one list and watch, so several parts of a page can follow the same objects without each listing and watching them.

## 0.1.0

### Minor Changes

- 7efaef5: Initial release. A Kubernetes client for the browser: typed REST operations for any resource, watch with automatic reconnect, and informers that keep a local copy of a set of objects up to date.
