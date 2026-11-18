# Reviewing a change

For whoever reviews a change to this repository, person or agent. Report what
is wrong or unproven; do not approve. Merging is a person's decision.

## Look at

- **The public API.** Everything exported from `src/index.ts`. A removed or
  renamed export, a changed type or a changed default is a breaking change
  and needs a changeset that says so.
- **A changeset** (`.changeset/*.md`) whenever users of the package get
  something different, and none for tests, CI or the demo.
- **Tokens.** Where an ID token or refresh token is kept, logged, put in a
  URL or sent; redirects and `state` in `src/oidc.ts`; what an error message
  or `src/log.ts` may reveal.
- **Timers and reconnecting** in `src/watch.ts`, `src/informer.ts`,
  `src/shared-informer.ts` and `src/visibility.ts`: a timer that is never
  cleared, a connection or listener that outlives `stop()`, a retry without
  backoff, an event delivered twice or lost across a reconnect, a
  `resourceVersion` that goes backwards.
- **Tests whose assertions changed.** Read these before the code. A test
  changed to agree with new behaviour needs a reason in the pull request. A
  removed or skipped test does too.
- **Anything that makes CI check less:** `|| true`, `continue-on-error`, a
  narrowed `include`, a longer timeout without a reason, a job condition.
- **Workflows.** Actions pinned to a commit, the least `permissions` that do
  the job, and no text from a pull request (title, body, branch name) in a
  `run:` step.
- **What the pull request says against what the diff does.** A claim under
  "Change" without a test or an entry under "Not verified" is a finding.

## Leave alone

- `pnpm-lock.yaml` and `.devcontainer/devcontainer-lock.json`, apart from
  checking that a change to them is expected.
- `CHANGELOG.md`, which the Release workflow writes.
- Formatting and import order, which `pnpm lint` decides.

## Keep it short

Report each finding once, with the file and line and what would go wrong.
After a fix, review only what changed. Stop after three rounds and leave what
is still open to the person who merges.
