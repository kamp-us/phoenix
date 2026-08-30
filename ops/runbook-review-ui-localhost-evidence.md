# Runbook: review-ui evidence for localhost-only products

Use this only for the Tuval harness declared in
`.github/review-ui-localhost-harnesses.json`. Ordinary web surfaces stay on the preview path. Run
all commands from the phoenix repository root.

## Read the wire contract

Read the required sections through the wire reader before acting; direct Markdown-anchor reads are
not the contract-ingestion surface.

```bash
skill_base=claude-plugins/fabrika/skills/review-ui
fabrika wire doc-section --heading "review-ui fetch" < "$skill_base/contract.md"
fabrika wire doc-section --heading "review-ui post" < "$skill_base/contract.md"
fabrika wire doc-section --heading "The shared exit matrix" < "$skill_base/contract.md"
```

## Restore a missing or stale #7190 artifact

1. Confirm #7190 is open. Record its full live head and the current default-branch authority
   revision.
2. Emit a fresh declared event at the unchanged PR head with the close/reopen sequence below. A
   PR-head change requires starting again at the new head.
3. Wait for `review-ui localhost evidence / tuval` from the declared workflow to complete
   successfully. Do not substitute another workflow, check, run, artifact, manifest, local path, or
   builder capture.
4. In an independent `review-ui` session, fetch the governed set and derive the exact head from the
   verb's validated output:

   ```bash
   fetch_json=$(fabrika review-ui fetch 7190 --harness tuval --out judged)
   printf '%s\n' "$fetch_json"
   live_head=$(node -e 'const row=JSON.parse(process.argv[1]); if(row.answer!=="fetched"||typeof row.head!=="string"||!/^[0-9a-f]{40}$/.test(row.head)) process.exit(1); process.stdout.write(row.head)' "$fetch_json")
   ```

5. Inspect both `tuval-cockpit-desktop` and `tuval-cockpit-mobile`, including each capture's bounded
   page/console-error evidence, against the design law. Exit `13` means the validated set was
   materialized with an uncaught page error: stderr names every materialized capture path, so inspect
   those pixels, treat the set as a red render, and post FAIL. Do not route proven red evidence to
   CANT-SEE.
6. Write the row-by-row judgment to exactly one of `verdict-pass.md` or `verdict-fail.md`, then run
   exactly one matching literal command:

   ```bash
   fabrika review-ui post 7190 --polarity PASS --sha "$live_head" --clause "accepted" --evidence judged < verdict-pass.md
   ```

   ```bash
   fabrika review-ui post 7190 --polarity FAIL --sha "$live_head" --clause "changes-requested" --evidence judged < verdict-fail.md
   ```

7. Re-read the landed marker through the normal review/ship flow. There is no localhost-specific
   marker or ship override.

Route a fetch refusal using the three wire sections read above rather than collapsing every nonzero
exit into CANT-SEE:

- Fix caller, invocation, or installation failures and retry before making any claim.
- If #7190 is absent or closed, end at CANT-SEE without a marker or note; there is no open subject on
  which to land one.
- If the head moved, restart at the new live head. If trusted red evidence was materialized, follow
  the inspect-then-FAIL route above.
- For any other trust or evidence refusal on an open, unmoved #7190, post CANT-SEE with
  `review-ui note`, repair the producer state named by the refusal, and repeat from the live head.
  Never substitute or import local bytes.

## Emit #7190's first declared event

GitHub documents that `pull_request_target` runs in the default-branch context, runs for `reopened`,
and applies a `paths` filter to the files changed by the PR
([event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target)).
The workflow declares `reopened` and matches `packages/tuval/**` plus `pnpm-lock.yaml`.

1. Confirm the workflow is present on the default branch, #7190 is open, and its changed-file set
   matches one of those paths. Record the PR's full live head.
2. Close #7190 without merging it, then reopen it. This emits the documented `reopened` activity
   after the default-branch authority exists; do not push or otherwise change the head as part of
   this retrigger.
3. Re-read the full live head. If it differs from the recorded head, restart at the new head. If it
   is unchanged, wait for `review-ui localhost evidence / tuval` at that exact head. A missing run is
   a producer-state failure, not permission to substitute evidence.
4. Consume the first completed exact-head run with the fetch and post commands above. Do not rerun a
   successful producer before fetching.

Do not add an `apps/web` route, preview deployment, Cloudflare binding, production endpoint, or
reviewer-local server to unblock Tuval.
