---
"kube-client-web": patch
---

`auth.token` keeps supplying the current ID token while it is valid when renewing it fails for a passing reason, such as a network error, instead of failing.
