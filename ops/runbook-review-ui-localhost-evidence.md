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
6. Post the ordinary verdict with the fetched set:

   ```bash
   fabrika review-ui post <pr> --polarity <PASS|FAIL> --sha <live-head> \
     --clause "<clause>" --evidence judged < verdict.md
   ```

7. Re-read the landed marker through the normal review/ship flow. There is no localhost-specific
   marker or ship override.

A fetch refusal is CANT-SEE, not permission to import local bytes. Post the blocker with
`review-ui note`; repair the producer state named by the refusal and repeat from the live head.

## Tuval PR #7190

After the platform authority is available on #7190's head, a `synchronize` event runs
`review-ui localhost evidence / tuval`. Fetch with `--harness tuval`, judge the desktop and mobile
captures plus browser-error evidence, and post through the ordinary marker as above. Do not add an
`apps/web` route, preview deployment, Cloudflare binding, production endpoint, or reviewer-local
server to unblock Tuval.
