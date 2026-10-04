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
   it never asserts the answer. The classifier is `classify` in
   [`packages/fabrika-cli/src/ship/codeowners.ts`](../../../packages/fabrika-cli/src/ship/codeowners.ts),
   and three verbs reach it: `fabrika ship scope` prints the state, `fabrika ship cp-approval`
   answers whether the approval it implies is discharged, and `fabrika lane prove` reads it to
   decide whether a §CP advisory on the pull request counts as a verdict.
3. **The output is three-valued**, and the third value is not a "no":

   | value | means |
   |---|---|
   | `control-plane` | a changed path is owned by a control-plane owner |
   | `not-control-plane` | CODEOWNERS was read, it bounds somebody, and no changed path is owned |
   | `unknown` | the classification could not be made over the boundary — a file that parses to no usable row, a file proven absent, or a boundary whose owned row matches every path (`*`, `/*`, `**`, `/**`, `**/*`) |

   **A proven-absent file and a failed read are different facts, and neither is
   `not-control-plane`.** *Proven absent* (a 404) is an empty row set, which classifies as the
   `unknown` hold. *Present* is parsed and classified, and a file that reads fine but bounds nobody
   is the `unknown` hold too. *Unreadable* is neither, and §4 says what happens to it.

   `fabrika ship scope` and `fabrika ship cp-approval` exit `7` on a pull request with no changed
   files, so neither asks the classifier about an empty path set.

4. **`unknown` is treated as §CP — fail closed.** An unreadable CODEOWNERS is not that `unknown`
   either — it is exit `11`, in every repo: a failed read proves nothing, so the verb refuses rather
   than answering, and no config value waives it. The `unreadableCodeowners` key is declared in the
   config registry and nothing reads it. Collapsing `unknown` → `not-control-plane` is the recurring
   fail-open defect; a boundary that resolves to zero owned paths stays a red, for the same reason
   every fabrika gate reds on zero scope — a gate that scanned nothing has judged nothing. §CP may
   have no residual gate behind it: under a ruleset with `required_approving_review_count: 0`,
   CODEOWNERS is the only source of required human review.
5. **Enforcement is the forge's, not the verb's.** The block is the native code-owner review
   requirement on the default branch's ruleset. The verb *routes*; CODEOWNERS *gates*. A verb answer
   is never the gate, so a wrong answer cannot open one.

## No semantic detection exists — path-set completeness is a maintenance obligation

Nothing in fabrika inspects what a change *says*. A guard-relaxing edit in a file no CODEOWNERS row
owns classifies `not-control-plane`, correctly per this model and by design.

> **Obligation.** When a surface becomes governance-bearing, its path is added to CODEOWNERS in the
> same change that creates it. **Owner: the control-plane team** — CODEOWNERS lives under
> `/.github/`, which that team already owns, so every edit to the boundary is itself a §CP change
> reviewed by the people accountable for it.

No content probe exists: classifying by what a change *says* would be a second answer to a
merge-gating question, which clause 1 rules out.

**Source still carries a path regex, and clause 1 rules against it.**
[`packages/fabrika-cli/src/guard/control-plane-re.ts`](../../../packages/fabrika-cli/src/guard/control-plane-re.ts)
names the control-plane paths a second time, and `fabrika guard codeowners-cp check` reds when a
path matching it has no covering CODEOWNERS row
([guard contract](guard-contract.md#codeowners-cp-check)). That regex is a second source of the path
set, and the guard has work only while both lists exist. The classifier reads CODEOWNERS and never
the regex.

### A decision corpus may be deliberately left uncovered

A repo may choose to give its decision-record directory no CODEOWNERS row, so that an
entirely-decision-record change set classifies `not-control-plane` and owes no code-owner review. Where a repo
makes that choice, four things hold:

- **A mixed PR is unaffected.** A change set touching the corpus alongside a team-owned path is
  `control-plane` by that other path.
- **The machine gate stays.** The corpus stays a governed root in
  [`packages/fabrika-cli/src/review/classes.ts`](../../../packages/fabrika-cli/src/review/classes.ts),
  so such a PR still owes a current-head `governance` verdict before `ship gate` is satisfied — at
  every review round, with the floor reported through a check run.
- **The sweep that stays is machine-run**: the citation-independent contradiction sweep run by
  [`governance`](../skills/governance/SKILL.md) (its corpus half, `§2`).
- **The visibility half**: a periodic, non-blocking readout of landed decision records, ranked for
  consequence and tension by the `governance` skill and surfaced on the front door.

That trade is a machine gate plus after-the-fact visibility standing in for a human approval. It
removes a human approval, not a gate — a repo that drops the machine half as well has removed the
review, not relocated it.

## Who reads this

- **Authoring sessions and briefs** naming `fabrika ship scope`, `fabrika ship cp-approval`,
  `fabrika lane prove` or `fabrika guard codeowners-cp check` — this is the contract those verbs
  implement; the interface they meet is [the CLI interface convention](interface-convention.md).
- **Skills that mention §CP.** State the expectation; never compute a second answer to a
  merge-gating question.
