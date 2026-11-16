---
"kube-client-web": minor
---

Informers and `watchWithReconnect` replace their watch connection as soon as the page becomes visible again after it was hidden for a while, and retry at once if they were waiting after a failure. A connection that died unnoticed in a background tab or while the machine slept no longer leaves the page with old data until the next deadline. The new option `reconnectAfterHiddenMs` sets how long the page must have been hidden, ten seconds by default; `Infinity` switches this off.
