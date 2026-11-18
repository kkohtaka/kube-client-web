# Working on kube-client-web

A Kubernetes client library for the browser. What it does and how to set up a
machine is in [README.md](README.md); this file says how a change gets checked
and reviewed. Most changes here are written by an agent and merged by one
person, so the checks and the description of a change carry the weight that a
second reader would.

## Checking a change

Run these before proposing a change, and say in the pull request what ran and
what did not:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm check:package
```

The end-to-end suites need a kind cluster (`pnpm e2e:up`), which needs Docker:

```sh
pnpm test:e2e          # Chromium, Firefox and WebKit
pnpm test:oidc
pnpm test:demo
pnpm test:e2e:faults
```

Run the ones the change touches. If they cannot run where you work, say so
under "Not verified" instead of leaving it out; CI runs all of them.

## Tests and CI are not to be bent

- A fix for a fault comes with a test that fails without the fix.
- Do not remove or skip a test, loosen an assertion, or make CI check less to
  get a change through. When a test has to change because the behaviour
  changes on purpose, say which and why in the pull request.
- Lint fails on `.skip` and `.only`. A skip that has to stay gets a
  `biome-ignore` comment with the reason.

## Review before a pull request

Before a pull request is opened, have the change reviewed by an agent that did
not write it: `/code-review`, which reads the diff without this conversation.
[REVIEW.md](REVIEW.md) says what to look for. Fix what it finds or say why not.

Changes to the paths below also get `/security-review`, and the person who
merges reads them in full, whatever their size. Name them under "Risk" in the
pull request:

- `.github/workflows/**`, most of all `release.yml`, which publishes to npm
- `src/oidc.ts`, and anything else that touches tokens, redirects or storage
- `exports`, `files`, scripts and dependencies in `package.json`
- `.devcontainer/**`
- `CLAUDE.md`, `REVIEW.md` and `.claude/**`: they change what the next agent does

## Pull requests

- One purpose each. Test infrastructure and a change of behaviour go in
  separate pull requests, and so does a refactoring that a change needs first.
- At most 600 changed lines, which the `Pull request size` workflow checks. A
  change that cannot be split gets the `large-change` label from the person
  who merges, not from the agent that wrote it.
- Follow the template: Problem, Change, Risk, Not verified. "Not verified" is
  the part a reader relies on most; list what was not run or not seen.
- A change to what users of the package get adds a changeset (`pnpm changeset`).
- Commit messages say why, in full sentences, as the existing ones do.
