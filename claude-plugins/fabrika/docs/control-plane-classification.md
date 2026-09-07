# fabrika §CP classification — CODEOWNERS is the single source of truth

The rule a fabrika verb answers "is this change control plane?" by, and the rule every fabrika skill
that *mentions* §CP is held to. This page states the rules only; a repo that wants the reasoning
behind a clause records it in its own decision corpus.

## The model

1. **CODEOWNERS is the single source of truth.** A change is control-plane **iff** it touches paths
   owned by a control-plane owner in [`.github/CODEOWNERS`](../../../.github/CODEOWNERS). There is
   no second source. **An owner is either an `@org/team` or an individual `@login`, and the two count
   the same**; an owner that is neither shape — a bare email — names no account an approval resolves
   against, so it bounds nothing.
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
   fail-open defect; a boundary that resolves to zero owned paths stays a red, for the same reason
   every fabrika gate reds on zero scope — a gate that scanned nothing has judged nothing. §CP may
   have no residual gate behind it: under a ruleset with `required_approving_review_count: 0`,
   CODEOWNERS is the only source of required human review.
5. **Enforcement is the forge's, not the verb's.** The block is the native code-owner review
   requirement on the default branch's ruleset. The verb *routes*; CODEOWNERS *gates*. A verb answer
   is never the gate, so a wrong answer cannot open one.

## No semantic detection exists — path-set completeness is a maintenance obligation

Nothing in fabrika inspects what a change *says*. A guard-relaxing edit in a file no CODEOWNERS row
owns classifies `not-§CP`, correctly per this model and by design.

> **Obligation.** When a surface becomes governance-bearing, its path is added to CODEOWNERS in the
> same change that creates it. **Owner: the control-plane team** — CODEOWNERS lives under
> `/.github/`, which that team already owns, so every edit to the boundary is itself a §CP change
> reviewed by the people accountable for it.

The tempting alternative — classifying by what a change *says* rather than where it lands — is not
built and is not wanted: a content probe is a second answer to a merge-gating question, and two
answers that can disagree is exactly what clause 1 forbids. The case it would cover resolves by
keeping the path set complete instead.

### A decision corpus may be deliberately left uncovered

A repo may choose to give its decision-record directory no CODEOWNERS row, so that an
entirely-decision-record change set classifies `not-§CP` and owes no code-owner review. Where a repo
makes that choice, four things hold:

- **A mixed PR is unaffected.** A change set touching the corpus alongside a team-owned path is
  `§CP` by that other path.
- **The machine gate stays.** The corpus stays a governed root in
  [`packages/fabrika-cli/src/review/classes.ts`](../../../packages/fabrika-cli/src/review/classes.ts),
  so such a PR still owes a current-head `governance` verdict before `ship gate` is satisfied — at
  every review round, with the floor reported through a check run.
- **The sweep that stays is machine-run**: the citation-independent contradiction sweep run by
  [`governance`](../skills/governance/SKILL.md) (its corpus half, `§2`).
- **The visibility half**: a periodic, non-blocking readout of landed decision records, ranked for
  consequence and tension by the governance-corpus-integrity skill and surfaced on the front door.

That trade is a machine gate plus after-the-fact visibility standing in for a human approval. It
removes a human approval, not a gate — a repo that drops the machine half as well has removed the
review, not relocated it.

## Who reads this

- **Authoring sessions and briefs** naming `cp-classify`, `control-plane-paths`, `cp-cardinality` or
  `codeowners-cp` — this is the contract those verbs implement; the interface they meet is
  [the CLI interface convention](cli-interface-convention.md).
- **Skills that mention §CP.** State the expectation; never compute a second answer to a
  merge-gating question.
