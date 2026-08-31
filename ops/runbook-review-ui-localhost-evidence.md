# Runbook: review-ui evidence for localhost-only products

Use this only for the Tuval harness declared in
`.github/review-ui-localhost-harnesses.json`. Ordinary web surfaces stay on the preview path. Run
all commands from the phoenix repository root.

## Read the wire contract

Read the required sections through the wire reader before invoking `review-ui fetch`; direct
Markdown-anchor reads are not the contract-ingestion surface.

```bash
fabrika wire doc-section --heading "review-ui fetch" < claude-plugins/fabrika/skills/review-ui/contract.md
fabrika wire doc-section --heading "review-ui post" < claude-plugins/fabrika/skills/review-ui/contract.md
fabrika wire doc-section --heading "review-ui note" < claude-plugins/fabrika/skills/review-ui/contract.md
fabrika wire doc-section --heading "The shared exit matrix" < claude-plugins/fabrika/skills/review-ui/contract.md
```

## Fetch and judge #7190

1. Confirm #7190 is open. Record its full live head and the current default-branch authority
   revision.
2. In an independent `review-ui` session, fetch the governed set. The verb prints one typed answer
   containing the exact full `head`, `render` state, capture paths, and bounded error evidence:

   ```bash
   fabrika review-ui fetch 7190 --harness tuval --out judged
   ```

3. Inspect both `tuval-cockpit-desktop` and `tuval-cockpit-mobile`, including each capture's bounded
   page/console-error evidence, against the design law. A successful answer with `render:"red"` is a
   validated set with an uncaught page error: inspect its listed pixels, treat the set as a red
   render, and post FAIL. Do not route proven red evidence to CANT-SEE. Any non-zero produced no
   fetch answer; route its typed code through the contract before taking a terminal.
4. Write the row-by-row judgment to exactly one of `verdict-pass.md` or `verdict-fail.md`, then run
   exactly one matching literal command:

   The following literal examples are bound to #7190's recorded head at this revision. If the fetch
   answer names another full head, type that exact literal into `--sha`; do not use a shell variable
   or command substitution.

   ```bash
   fabrika review-ui post 7190 --polarity PASS --sha d293fe694bfd740475753bad3b00c630a9835122 --clause "accepted" --evidence judged < verdict-pass.md
   ```

   ```bash
   fabrika review-ui post 7190 --polarity FAIL --sha d293fe694bfd740475753bad3b00c630a9835122 --clause "changes-requested" --evidence judged < verdict-fail.md
   ```

5. Re-read the landed marker through the normal review/ship flow. There is no localhost-specific
   marker or ship override.

Route a fetch refusal only by the typed code from the three wire sections above, never by stderr:

- Exit `10`: correct the caller operand and refetch.
- Exit `12`: discard the stale attempt, read the new live head, and refetch that exact head.
- Exit `4`, `15`, or `18`: the producer evidence is proven malformed, invalid, or unavailable. On an
  open PR, post a non-marker blocker with `review-ui note`. Route that write only by its numeric exit
  code, never stderr: note exit `0` proves the exact read-back, so hand the recovery below to an
  operator and stop CANT-SEE; note exit `8` or `9` stops ESCALATED with no marker; note exit `11`
  stops UNKNOWN with no marker. Never claim CANT-SEE from note exit `8`, `9`, or `11`. A reviewer
  never changes PR state to manufacture another producer event.
- Exit `7`: #7190 is proven absent or closed. End CANT-SEE without a marker or note; there is no open
  subject on which to land one.
- Exit `11`, `1`, `126`, `127`, or an unlisted code: end UNKNOWN. The invocation produced no evidence
  answer, marker, or note. Route the typed code to the supervisor for retry or replacement of the
  transport, token, authority-read, scratch, unzip, installation, or runtime path; do not report
  CANT-SEE.

## Operator-owned dropped-trigger recovery

Close/reopen recovery belongs to the `ship` capability set, not `review-ui`. Hand the open PR, its
recorded full head, and the governed `tuval` harness id to an operator. Before the request, the
operator must read the dedicated literal section through the contract-ingestion surface:

```bash
fabrika wire doc-section --heading "ship review-ui-request" < claude-plugins/fabrika/skills/ship/contract.md
```

After that read succeeds, the operator may invoke the sanctioned, self-guarding route. The literal
example below is bound to #7190's recorded head at this revision. If the operator's fresh read names
another full head, the operator types that exact literal into `--sha`.

```bash
fabrika ship review-ui-request 7190 --sha d293fe694bfd740475753bad3b00c630a9835122 --harness tuval
```

`ship review-ui-request` binds the open PR, full exact head, and current default-branch governed
harness declaration; exhaustively enumerates checks, statuses, and declared-workflow runs; and
proceeds only when this exact governed evidence check/run is absent. Unrelated ordinary checks do
not block it. Pending, successful, failed, or ambiguous governed evidence refuses. The verb enforces
at most one request with a durable exact-head+harness marker and race read-back, performs both
PR-state writes, reads both legs back, and
retains the loud exit `17` when the close landed but reopening is unconfirmed. A refusal is not
permission for the reviewer to reproduce the writes manually; the operator resolves or escalates it
under the ship contract. After a confirmed request and a successful exact-head producer run, start a
fresh independent review-ui session at the contract reads above.

Do not add an `apps/web` route, preview deployment, Cloudflare binding, production endpoint, or
reviewer-local server to unblock Tuval.
