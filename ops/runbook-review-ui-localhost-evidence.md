# Runbook: review-ui evidence for localhost-only products

Use this only for a harness declared in `.github/review-ui-localhost-harnesses.json`. Ordinary web
surfaces stay on the preview path.

## Restore a missing or stale artifact

1. Confirm the pull request is open and note its full live head.
2. Re-run or retrigger the declared `review-ui localhost evidence / <harness>` check at that exact
   head. A head change invalidates the prior artifact.
3. Wait for the declared check to complete successfully. Do not substitute another workflow, check,
   run, artifact, manifest, local path, or builder capture.
4. In an independent `review-ui` session, fetch the governed set:

   ```bash
   fabrika review-ui fetch <pr> --harness <id> --out judged
   ```

5. Inspect every returned PNG and its bounded page/console-error evidence against the design law.
   Exit `13` means the validated set was materialized with an uncaught page error: stderr names every
   materialized capture path, so inspect those pixels, then treat the set as a red render and post
   FAIL. Do not route it to CANT-SEE.
6. Post the ordinary verdict with the fetched set:

   ```bash
   fabrika review-ui post <pr> --polarity <PASS|FAIL> --sha <live-head> \
     --clause "<clause>" --evidence judged < verdict.md
   ```

7. Re-read the landed marker through the normal review/ship flow. There is no localhost-specific
   marker or ship override.

Route a fetch refusal by its contract instead of collapsing every nonzero exit into CANT-SEE:

- `1` or `10` is a caller error. Correct the invocation or closed-vocabulary value and retry; do not
  post a blocker.
- `7` means the PR is absent or closed. End the review without a marker or blocker note.
- `12` means the head moved. Restart at the new live head.
- `13` follows the inspect-then-FAIL route above.
- `4`, `11`, or `15` on an open, unmoved PR means the governed evidence cannot be trusted or seen.
  Post CANT-SEE with `review-ui note`, repair the producer state named by the refusal, and repeat from
  the live head. It is never permission to import local bytes.
- `126` or `127` means the trusted verb did not run. Repair the local installation/invocation before
  making any claim about the PR.

## Tuval PR #7190

After the platform authority reaches the default branch, #7190 needs its first run even when its head
is unchanged. Close and reopen the PR: `reopened` is a declared `pull_request_target` activity type
for `review-ui-localhost-evidence.yml`, so that cycle creates the first
`review-ui localhost evidence / tuval` run at the same exact head. After a run exists, the Actions UI
may rerun it without another PR event.

Fetch with `--harness tuval`, judge the desktop and mobile captures plus browser-error evidence, and
post through the ordinary marker as above. Do not add an `apps/web` route, preview deployment,
Cloudflare binding, production endpoint, or reviewer-local server to unblock Tuval.
