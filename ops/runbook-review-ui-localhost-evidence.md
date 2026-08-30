# Runbook: review-ui evidence for localhost-only products

Use this only for the Tuval harness declared in
`.github/review-ui-localhost-harnesses.json`. Ordinary web surfaces stay on the preview path. Run
all commands from the phoenix repository root.

## Read the wire contract

Read the required sections through the wire reader before invoking `review-ui fetch`; direct
Markdown-anchor reads are not the contract-ingestion surface.

```bash
skill_base=claude-plugins/fabrika/skills/review-ui
fabrika wire doc-section --heading "review-ui fetch" < "$skill_base/contract.md"
fabrika wire doc-section --heading "review-ui post" < "$skill_base/contract.md"
fabrika wire doc-section --heading "The shared exit matrix" < "$skill_base/contract.md"
```

## Fetch and judge #7190

1. Confirm #7190 is open. Record its full live head and the current default-branch authority
   revision.
2. In an independent `review-ui` session, fetch the governed set and derive the exact head from the
   verb's validated output:

   ```bash
   fetch_json=$(fabrika review-ui fetch 7190 --harness tuval --out judged)
   printf '%s\n' "$fetch_json"
   live_head=$(node -e 'const row=JSON.parse(process.argv[1]); if(row.answer!=="fetched"||typeof row.head!=="string"||!/^[0-9a-f]{40}$/.test(row.head)) process.exit(1); process.stdout.write(row.head)' "$fetch_json")
   ```

3. Inspect both `tuval-cockpit-desktop` and `tuval-cockpit-mobile`, including each capture's bounded
   page/console-error evidence, against the design law. Exit `13` means the validated set was
   materialized with an uncaught page error: stderr names every materialized capture path, so inspect
   those pixels, treat the set as a red render, and post FAIL. Do not route proven red evidence to
   CANT-SEE.
4. Write the row-by-row judgment to exactly one of `verdict-pass.md` or `verdict-fail.md`, then run
   exactly one matching literal command:

   ```bash
   fabrika review-ui post 7190 --polarity PASS --sha "$live_head" --clause "accepted" --evidence judged < verdict-pass.md
   ```

   ```bash
   fabrika review-ui post 7190 --polarity FAIL --sha "$live_head" --clause "changes-requested" --evidence judged < verdict-fail.md
   ```

5. Re-read the landed marker through the normal review/ship flow. There is no localhost-specific
   marker or ship override.

Route a fetch refusal using the three wire sections read above rather than collapsing every nonzero
exit into CANT-SEE:

- Fix caller, invocation, or installation failures and retry before making any claim.
- If #7190 is absent or closed, end at CANT-SEE without a marker or note; there is no open subject on
  which to land one.
- If the head moved, restart at the new live head. If trusted red evidence was materialized, follow
  the inspect-then-FAIL route above.
- For any other trust or evidence refusal on an open, unmoved #7190, post CANT-SEE with
  `review-ui note` and stop. A reviewer never changes PR state to manufacture another producer
  event.

## Operator-owned dropped-trigger recovery

Close/reopen recovery belongs to the `ship` capability set, not `review-ui`. Hand the open PR and
its recorded full head to an operator. The operator reads the `ship nudge` contract and may invoke
the sanctioned, self-guarding route:

```bash
fabrika ship nudge 7190 --sha "$live_head"
```

`ship nudge` re-derives the dropped-trigger precondition, enforces at-most-once recovery for the
head, performs both PR-state writes, and reads both legs back. A refusal is not permission for the
reviewer to reproduce the writes manually; the operator resolves or escalates it under the ship
contract. After a confirmed nudge and a successful exact-head producer run, start a fresh independent
review-ui session at the contract reads above.

Do not add an `apps/web` route, preview deployment, Cloudflare binding, production endpoint, or
reviewer-local server to unblock Tuval.
