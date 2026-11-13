---
"kube-client-web": minor
---

Add shared informers. `client.sharedInformers()` returns a factory whose informers for the same resource, namespace and selectors are served by one list and watch, so several parts of a page can follow the same objects without each listing and watching them.
