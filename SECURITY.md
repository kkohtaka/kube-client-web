# Security policy

## Supported versions

Security fixes are made to the latest release only.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: on the repository's
[Security tab](https://github.com/kkohtaka/kube-client-web/security), choose
**Report a vulnerability**. If that button is missing, open an issue that asks
for a private contact, without any details of the problem.

Include what you can of:

- the version of `kube-client-web` and the browser,
- what an attacker can do, and what they need for it,
- steps or code that show the problem.

This is a project maintained in spare time, so there is no guaranteed response
time. You will get an answer as soon as possible, and credit in the release
notes unless you prefer otherwise.

## Scope

`kube-client-web` runs in the browser and sends the bearer token it is given to
the API server it is pointed at. Problems in scope include a token reaching
another origin, or a response from the server making the library do something
its caller did not ask for.

How a page obtains and stores its token, and the CORS and TLS configuration of
the cluster, are decisions of the application and the cluster operator. See
[Cluster requirements](README.md#cluster-requirements).
