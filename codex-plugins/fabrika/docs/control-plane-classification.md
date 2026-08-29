# fabrika §CP classification — CODEOWNERS is the single source of truth

The rule a fabrika verb answers "is this change control plane?" by, and the rule every fabrika skill
that *mentions* §CP is held to. This page states the rules only; the reasoning and ruling history
behind each clause live under [`.decisions/`](../../../.decisions/) and are pointed at inline.

## The model

1. **CODEOWNERS is the single source of truth.** A change is control-plane **iff** it touches paths
   owned by a control-plane owner in [`.github/CODEOWNERS`](../../../.github/CODEOWNERS). There is
   no second source ([ADR 0330](../../../.decisions/0330-codeowners-is-the-cp-boundary.md), ADR
   [0053](../../../.decisions/0053-control-plane-boundary.md)). **An owner is either an `@org/team`
   or an individual `@login`, and the two count the same**; an owner that is neither shape — a bare
   email — names no account an approval resolves against, so it bounds nothing
   ([ADR 0330](../../../.decisions/0330-codeowners-is-the-cp-boundary.md)). In this repo nothing
   moves: every CODEOWNERS row here names `@kamp-us/control-plane`.
2. **A verb computes it, from two inputs and nothing else** — the CODEOWNERS file and the diff's
   changed paths. **No agent judgement, and no content regex.** A skill may state the expectation;
   it never asserts the answer.
3. **The output is three-valued**, and the third value is not a "no":

   | value | means |
   |---|---|
   | `§CP` | a changed path is owned by a control-plane owner |
   | `not-§CP` | CODEOWNERS was read, it bounds somebody, and no changed path is owned |
   | `UNKNOWN` | the classification could not be made over the boundary — a file that parses to no usable row, a file proven absent, an empty path set |

   **A proven-absent file and a failed read are different facts, and neither is `not-§CP`.**
   *Proven absent* (a 404) is an empty row set, which classifies as the `UNKNOWN` hold. *Present* is
   parsed and classified, and a file that reads fine but bounds nobody is the `UNKNOWN` hold too.
   *Unreadable* is neither, and §4 says what happens to it.

4. **`UNKNOWN` is treated as §CP — fail closed.** An unreadable CODEOWNERS is not that `UNKNOWN`
   either — it is exit `11`, in every repo: a failed read proves nothing, so the verb refuses rather
   than answering, and no config value waives it. Collapsing `UNKNOWN` → `not-§CP` is the recurring
   fail-open defect (ADR
   [0220](../../../.decisions/0220-cp-surface-declared-at-standup.md) §4); a boundary that resolves
   to zero owned paths stays a red (ADR
   [0092](../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)). §CP has no residual gate
   behind it — under a ruleset with `required_approving_review_count: 0`, CODEOWNERS is the only
   source of required human review. A deprecated per-repo `unreadableCodeowners` key still resolves
   in `.fabrika.jsonc`'s vocabulary and nothing reads it (ADR
   [0307](../../../.decisions/0307-unreadable-codeowners-is-per-repo.md), retired).
5. **Enforcement is GitHub's, not the verb's.** The block is the native code-owner review
   requirement on the `main` ruleset (ADR
   [0135](../../../.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md),
   ADR [0053](../../../.decisions/0053-control-plane-boundary.md)). The verb *routes*; CODEOWNERS
   *gates*. A verb answer is never the gate, so a wrong answer cannot open one.

## No semantic detection exists — path-set completeness is a maintenance obligation

Nothing in fabrika inspects what a change *says*. A guard-relaxing edit in a file no CODEOWNERS row
owns classifies `not-§CP`, correctly per this model and by design.

> **Obligation.** When a surface becomes governance-bearing, its path is added to CODEOWNERS in the
> same change that creates it. **Owner: the `@kamp-us/control-plane` team** — CODEOWNERS lives under
> `/.github/`, which that team already owns, so every edit to the boundary is itself a §CP change
> reviewed by the people accountable for it.

A content-signal case — ADR
[0164](../../../.decisions/0164-guard-relaxing-adr-cp-gate.md)'s "§CP by what it says" — resolves by
path completeness, not by a probe ([ADR 0330](../../../.decisions/0330-codeowners-is-the-cp-boundary.md)).

### The one surface deliberately left uncovered: `.decisions/`

`.decisions/` carries no CODEOWNERS row: an entirely-ADR change set classifies `not-§CP` and owes no
code-owner review.

- **A mixed PR is unaffected.** A change set touching `.decisions/` alongside a team-owned path is
  `§CP` by that other path.
- **The machine gate stays.** `.decisions/` remains one of the four `GOVERNANCE_ROOTS` in
  [`packages/fabrika-cli/src/review/classes.ts`](../../../packages/fabrika-cli/src/review/classes.ts),
  so an ADR PR still owes a current-head `governance` verdict before `ship gate` is satisfied — at
  every review round ([ADR 0293](../../../.decisions/0293-governance-fires-every-round.md)), with
  the floor reported through a check-run
  ([ADR 0318](../../../.decisions/0318-the-governance-floor-reports-through-a-check-run.md)). This
  is the substitution of a machine gate plus after-the-fact visibility for human approval (ADR
  [0274](../../../.decisions/0274-fabrika-tree-is-not-control-plane.md) §2) applied to the ADR case;
  it removed a human approval, not a gate.
- **The sweep that stays is machine-run**: the citation-independent ADR contradiction sweep run today
  by [`governance`](../skills/governance/SKILL.md) (its corpus half, `§2`). The v1 `review-doc`
  skill that first carried the sweep is deleted (ADR
  [0303](../../../.decisions/0303-retire-kampus-pipeline-plugin.md)).
- **The visibility half of the substitution**: a periodic, non-blocking readout of landed ADRs,
  ranked for consequence and tension by the governance-corpus-integrity skill and surfaced on the
  front door (ADR [0274](../../../.decisions/0274-fabrika-tree-is-not-control-plane.md)).

## Relation to v1

v1's `pipeline-cli cp-classify` answers a different question: two independent sources (the
`CONTROL_PLANE_RE` path regex plus an ADR-0164-style content probe over touched `.decisions/**`
files) and four states, including `content-undetermined`. Fabrika's verb is CODEOWNERS-only and
three-valued, and fabrika does not call v1 and does not patch it (ADR
[0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)); v1's model governs no
fabrika artifact.

## Who reads this

- **Authoring sessions and briefs** naming `cp-classify`, `control-plane-paths`, `cp-cardinality` or
  `codeowners-cp` — this is the contract those verbs implement; the interface they meet is
  [the CLI interface convention](cli-interface-convention.md).
- **Skills that mention §CP.** State the expectation; never compute a second answer to a
  merge-gating question.
