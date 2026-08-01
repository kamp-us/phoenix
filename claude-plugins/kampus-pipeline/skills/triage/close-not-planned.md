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
3. Apply `closed-by-triage` so every kill shows up in one query.
4. Close as **not planned** (state `closed`, reason `not_planned`).

```bash
# step 1 only when closing as a duplicate of #M. Both scripts resolve the SAME §SP per-run scratch
# namespace through the shared lib's kp_scratch_* seam — an issue number is NOT unique, and a
# clobbered file reads back cleanly as another run's body, preserving the WRONG original (#3718).
RUN_SCRATCH="$(bash ./claude-plugins/kampus-pipeline/skills/triage/scripts/fetch-duplicate-body.sh <N>)" || exit 1
# then wrap $RUN_SCRATCH/dup.md in <details> as $RUN_SCRATCH/dup-comment.md, and:
bash ./claude-plugins/kampus-pipeline/skills/triage/scripts/post-duplicate-comment.sh <N> <M>
# steps 2-4, every kill:
bash ./claude-plugins/kampus-pipeline/skills/triage/scripts/close-not-planned.sh <N> "<specific reason>."
```

The scripts live in [`scripts/`](scripts/) alongside the rest of this skill's extracted shell; the
extraction contract and the `set -uo pipefail`-without-`-e` rationale are in
[`SKILL.md` § The extracted scripts](./SKILL.md#the-extracted-scripts).

The maintainer audits all kills with one query, so over-closing is caught and reopened
cheaply:

```bash
bash ./claude-plugins/kampus-pipeline/skills/triage/scripts/audit-kills.sh
```
