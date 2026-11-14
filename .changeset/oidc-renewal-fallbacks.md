---
"kube-client-web": patch
---

`auth.token` keeps supplying the current ID token while it is valid when renewing it fails for a passing reason, such as a network error, instead of failing. A provider that renews a session without a new ID token no longer loses the new refresh token; the session ends with a `SignInRequiredError` that names the cause once the ID token expires.
