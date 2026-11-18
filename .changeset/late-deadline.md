---
"kube-client-web": patch
---

A watch no longer gives up on its connection the moment a page runs again after it did not run for a while, in a background tab or while the machine slept. The deadlines of `timeoutSeconds` and `idleTimeoutMs` had passed by then, but nothing the server sent could be read in the meantime either. The page now first gets two seconds to read what the connection holds. Safari stops the pages of background tabs within seconds, so informers there reported "the server did not end the watch when it was due" on every return to the tab.
