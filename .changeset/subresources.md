---
"kube-client-web": minor
---

Add pod logs and subresources. `log()` reads the log of a pod's container and `followLog()` follows it line by line as it grows. `getScale()` and `scale()` read and set the replicas of anything with a scale subresource. `subresource()` reaches any other subresource of an object, such as `eviction`.
