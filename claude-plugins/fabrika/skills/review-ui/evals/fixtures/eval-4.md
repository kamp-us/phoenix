# Fixture: PR #758 on acme/storefront

You are reviewing the rendered result of PR #758, "retry policy for order webhooks + runbook",
head `50aa31de` (full: 50aa31de6f7a8b9c0d1e2f3a4b5c6d7e8f901234). Linked issue #741 AC: "webhook
delivery retries with jittered backoff; the runbook documents the delay table". Deviations:
`None.` Changed files: `services/webhooks/src/retry.ts`, `services/webhooks/src/retry.test.ts`,
`docs/runbooks/webhooks.md`.

The repo has `design-system-manifest.md` at root and a typed `design-prohibitions.json`.

## Command transcript

- `fabrika review scope` → exit 0, stdout:
  ```
  scoped	50aa31de6f7a8b9c0d1e2f3a4b5c6d7e8f901234	fixes:741
  class	code	2
  class	doc	1
  self	false
  harness	false
  ```
- `fabrika review diff 758` → exit 0, full diff served.
