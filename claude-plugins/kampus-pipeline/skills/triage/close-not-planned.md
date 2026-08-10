# triage — Close not-planned (kill protocol)

The detailed protocol for the **rare** third triage outcome: closing an *agent-filed*,
genuinely-unsalvageable issue. The `triage` SKILL points here from Step 6 and Step 3
(empty-husk close) and `Read`s this on demand only when it has decided to close — keeping
the resident skill core focused on the common triaged / needs-info paths, which never need
these mechanics (the fan-out-economics split, [#1374](https://github.com/kamp-us/phoenix/issues/1374)).

Close an issue **only** when it's an *agent-filed* issue that is genuinely unsalvageable —
a duplicate of an existing issue, an observation that's no longer true (the code moved on),
a non-actionable note with nothing to enrich into, or noise. **Salvage first**: if there's
a real unit hiding in it, enrich and triage it instead. **Never close a human-filed
issue** (Step 5 — human issues go to `status:needs-info`, never closed).

Every kill is auditable and reversible. Always:

1. **If the reason is "duplicate of #M": preserve the loser's content on the survivor
   first.** A bare cross-link is not enough — the closed issue often carries context the
   survivor lacks (an independent verification, extra pointers, a sharper acceptance idea).
   Copy the duplicate's full body **verbatim** into a comment on #M, wrapped in a
   `<details><summary>#N (closed duplicate) — full body</summary>…</details>` block, and
   fold anything load-bearing into #M's enrichment. Nothing a reporter wrote should require
   clicking into a closed issue to read.
2. Post a **reason comment** — *why* it's unsalvageable, specifically (e.g. "Duplicate of
   #33, which already tracks this hang" or "The function this references was removed in #30;
   no longer applicable"). One sentence of real reasoning, so the maintainer reviewing kills
   can judge it.
3. Apply `closed-by-triage` to record that **triage** executed this kill. The label is provenance,
   not coverage — it says *who*, never *whether* (ADR
   [0256](https://github.com/kamp-us/phoenix/blob/main/.decisions/0256-kill-audit-keys-on-the-not-planned-close.md)).
   Never apply it to a close triage did not execute.
4. Close as **not planned** (state `closed`, reason `not_planned`). This close is what makes the kill
   auditable — see the audit below.

```bash
# step 1 only when closing as a duplicate of #M. Both scripts resolve the SAME §SP per-run scratch
# namespace through the shared lib's kp_scratch_* seam — an issue number is NOT unique, and a
# clobbered file reads back cleanly as another run's body, preserving the WRONG original (#3718).
RUN_SCRATCH="$("${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/triage/scripts/fetch-duplicate-body.sh" <N>)" || exit 1
# then wrap $RUN_SCRATCH/dup.md in <details> as $RUN_SCRATCH/dup-comment.md, and:
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/triage/scripts/post-duplicate-comment.sh" <N> <M>
# steps 2-4, every kill:
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/triage/scripts/close-not-planned.sh" <N> "<specific reason>."
```

The scripts live in [`scripts/`](scripts/) alongside the rest of this skill's extracted shell; the
extraction contract and the `set -uo pipefail`-without-`-e` rationale are in
[`SKILL.md` § The extracted scripts](./SKILL.md#the-extracted-scripts).

The maintainer's kill audit is an audit of **every not-planned close, whoever executed it** — the
close is the audit's key, and `closed-by-triage` reads as a provenance column on the rows triage
killed (ADR
[0256](https://github.com/kamp-us/phoenix/blob/main/.decisions/0256-kill-audit-keys-on-the-not-planned-close.md)).
That is what lets over-closing be caught and reopened cheaply whoever ran the close:

```bash
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/triage/scripts/audit-kills.sh"
```

**The script itself is not re-keyed yet**, so read its output for what it currently is: triage's own
labelled kills, first page only. The re-key onto `state_reason=not_planned` travels with the same
query's pagination repair ([#4928](https://github.com/kamp-us/phoenix/issues/4928)) — until then the
audit under-reports in both directions ([#5280](https://github.com/kamp-us/phoenix/issues/5280) is
the re-key).
