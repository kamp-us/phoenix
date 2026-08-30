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
   Exit `13` means the validated set was materialized with an uncaught page error: treat that as a
   red render and post FAIL from the set. Do not route it to CANT-SEE.
6. Post the ordinary verdict with the fetched set:

   ```bash
   fabrika review-ui post <pr> --polarity <PASS|FAIL> --sha <live-head> \
     --clause "<clause>" --evidence judged < verdict.md
   ```

7. Re-read the landed marker through the normal review/ship flow. There is no localhost-specific
   marker or ship override.

A fetch refusal other than `13` is CANT-SEE, not permission to import local bytes. Post the blocker
with `review-ui note`; repair the producer state named by the refusal and repeat from the live head.
A moved-head `12` restarts at the new head. Exit `13` follows the FAIL route above.

## Tuval PR #7190

After the platform authority reaches the default branch, #7190 needs its first run even when its head
is unchanged. Close and reopen the PR: `reopened` is a declared `pull_request_target` activity type
for `review-ui-localhost-evidence.yml`, so that cycle creates the first
`review-ui localhost evidence / tuval` run at the same exact head. After a run exists, the Actions UI
may rerun it without another PR event.

Fetch with `--harness tuval`, judge the desktop and mobile captures plus browser-error evidence, and
post through the ordinary marker as above. Do not add an `apps/web` route, preview deployment,
Cloudflare binding, production endpoint, or reviewer-local server to unblock Tuval.
