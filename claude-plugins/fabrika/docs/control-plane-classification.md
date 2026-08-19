# fabrika §CP classification — CODEOWNERS is the single source of truth

The rule a fabrika verb answers "is this change control plane?" by, and the rule every fabrika skill
that *mentions* §CP is held to. Founder ruling, 2026-08-08, recorded first-hand on
[#4927](https://github.com/kamp-us/phoenix/issues/4927) and transcribed here so a brief, a contract
spec or a verb implementer can cite a file instead of a comment
([#4932](https://github.com/kamp-us/phoenix/issues/4932)).

## The model

1. **CODEOWNERS is the single source of truth.** A change is control-plane **iff** it touches paths
   owned by the control-plane team in [`.github/CODEOWNERS`](../../../.github/CODEOWNERS). There is
   no second source.
2. **A verb computes it, from two inputs and nothing else** — the CODEOWNERS file and the diff's
   changed paths. **No agent judgement, and no content regex.** A skill may state the expectation;
   it never asserts the answer.
3. **The output is three-valued**, and the third value is not a "no":

   | value | means |
   |---|---|
   | `§CP` | a changed path is owned by the control-plane team |
   | `not-§CP` | CODEOWNERS was read, and no changed path is owned |
   | `UNKNOWN` | the classification could not be made — unreadable/unparseable CODEOWNERS, empty path set |

4. **`UNKNOWN` is treated as §CP — fail closed.** A read that failed and a change that is genuinely
   ordinary are different facts, and collapsing them is this repo's dominant defect class (a check
   that cannot see its subject answering confidently instead of erroring). A false §CP costs one
   approval; a false ordinary reaches `main` with none.
5. **Enforcement is GitHub's, not the verb's.** The block is the native code-owner review
   requirement on the `main` ruleset (ADR
   [0135](../../../.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md),
   ADR [0053](../../../.decisions/0053-control-plane-boundary.md)). The verb *routes*; CODEOWNERS
   *gates*. A verb answer is never the gate, so a wrong answer cannot open one.

## No semantic detection exists — path-set completeness is a maintenance obligation

**Stated explicitly, because it is the model's one load-bearing assumption:** nothing in fabrika
inspects what a change *says*. A guard-relaxing edit in a file no CODEOWNERS row owns classifies
`not-§CP`, correctly per this model and by design.

That makes **coverage of the owned-path set the whole protection**, and therefore an obligation
somebody owns rather than a property that holds by itself:

> **Obligation.** When a surface becomes governance-bearing, its path is added to CODEOWNERS in the
> same change that creates it. **Owner: the `@kamp-us/control-plane` team** — CODEOWNERS lives under
> `/.github/`, which that team already owns, so every edit to the boundary is itself a §CP change
> reviewed by the people accountable for it.

ADR [0164](../../../.decisions/0164-guard-relaxing-adr-cp-gate.md)'s "§CP by what it says" case
resolves **here**, by path completeness — not by a probe. Where 0164 wanted a content signal, the
answer is a CODEOWNERS row.

### The one surface deliberately left uncovered: `.decisions/`

Later the same day (2026-08-08, on the same thread) the founder ruled the ADR case specifically, and
that ruling supersedes any reading of the above that would put `.decisions/` in CODEOWNERS:

- `.decisions/` does **not** become team-owned; ADRs get **no** code-owner review. This declines a
  widening — `.decisions/` has no CODEOWNERS row today — rather than removing a protection.
- The guard that stays is machine-run: the citation-independent ADR contradiction sweep, run today
  by [`governance`](../skills/governance/SKILL.md) (its corpus half, `§2`). The v1 `review-doc`
  skill that first carried the sweep is deleted (ADR 0303).
- **The condition attached to the ruling, and not droppable:** the gate is replaced by a periodic,
  non-blocking **readout** of landed ADRs, ranked for consequence and tension by the
  governance-corpus-integrity skill and surfaced on the front door. Without it, "supersede later" is
  fiction.

So an ADR classifies `not-§CP` under this model, and that is the ruled outcome, not a gap.

**Re-ruled 2026-08-15 ([#5531](https://github.com/kamp-us/phoenix/issues/5531)), because the code
had drifted the other way.** `classify()` in
[`packages/fabrika-cli/src/ship/codeowners.ts`](../../../packages/fabrika-cli/src/ship/codeowners.ts)
was returning a fourth state, `content-undetermined`, for any change set touching `.decisions/`,
which routed every ADR PR onto the approval path this section says it does not owe. The founder
ruled the doc's side — *"adrs shouldn't be control-plane"* — so the state left fabrika's `CpState`
entirely and the verb is three-valued in code as well as here.

Two boundaries on that, so nothing wider was narrowed:

- **A mixed PR is unaffected.** This governs a change set that is *entirely* `.decisions/`. A PR
  touching `.decisions/` alongside a team-owned path is `§CP` by that other path, unchanged.
- **The machine gate is untouched.** `.decisions/` remains one of the four `GOVERNANCE_ROOTS` in
  [`packages/fabrika-cli/src/review/classes.ts`](../../../packages/fabrika-cli/src/review/classes.ts),
  so an ADR PR still owes a current-head `governance` verdict before `ship gate` is satisfied — the
  diff-derived floor, not a caller-asserted flag. This removed a human approval, not a gate, which
  is ADR [0274](../../../.decisions/0274-fabrika-tree-is-not-control-plane.md) §2's
  substitution applied to the ADR case. `.github/CODEOWNERS` gained no row and lost none.

## What this changes relative to v1

v1's `pipeline-cli cp-classify`
answers a **different** question and is not wrong at what it does: it has two independent sources —
the `CONTROL_PLANE_RE` path regex *and* an ADR-0164 content probe over touched `.decisions/**` files
— and four states, including `content-undetermined`, which is an obligation to probe rather than a
verdict. fabrika's verb is CODEOWNERS-only and three-valued.

Per ADR [0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md), fabrika does not
call v1 and does not patch it. v1's model is described here only so a reader who meets both knows
which one governs a fabrika artifact.

## Who reads this

- **Authoring sessions and briefs** naming `cp-classify`, `control-plane-paths`, `cp-cardinality` or
  `codeowners-cp` — this is the contract those verbs implement; the interface they meet is
  [the CLI interface convention](cli-interface-convention.md).
- **Skills that mention §CP.** The rule is: state the expectation, never compute a second answer to
  a merge-gating question ([#4227](https://github.com/kamp-us/phoenix/issues/4227) is the cost of
  the second opinion — a routing note contradicted a settled ruling and a lane was planned around an
  approval that never fires).
