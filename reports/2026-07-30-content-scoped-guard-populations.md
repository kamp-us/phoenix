# Content-scoped guard populations in `packages/pipeline-cli` — inventory, coverage verdicts, recommendation

*Dated findings — 2026-07-30. Investigation for [#4509](https://github.com/kamp-us/phoenix/issues/4509)
(milestone "Skill Harness Audit", epic [#4435](https://github.com/kamp-us/phoenix/issues/4435)).*

**The question.** Some guards and pins in `packages/pipeline-cli` compute *which files they assert
about* from file **content** — "every claim writer whose text contains a layer-one write". The
shell-extraction programme relocates exactly that content into sibling `scripts/*.sh`, so a file can
exit a guard's asserted population while the suite stays green. A shrinking population and a fully
covered one produce byte-identical test output, so nobody can tell from a green run how much a pin
still covers. How many such pins exist, which of them actually lost coverage, and is content-derived
self-scoping acceptable at all?

**The answer, up front.** There are **four** content-derived subject populations in the package.
**None has silently lost coverage on `main` today**, but only one of the four is safe *by design*:

- The instance the ticket was filed on (`adoption-lint`'s #4015 ordering pin) was **repaired on
  `main` while this investigation ran**, by PR [#4503](https://github.com/kamp-us/phoenix/pull/4503)
  (merged 2026-07-30, `b015fa48`) — and it was repaired with **exactly the mechanism recommended
  below**: a declared `LAYER_ONE_WRITING_FILES` membership asserted equal to the derived population.
  That is not a coincidence to wave away, it is the strongest evidence in this report: an independent
  lane, reasoning from the same failure, arrived at declared-population equality.
- The other three are guarded only by a **count floor** (`>= 3`, `> 0`, `.some()`), and a count floor
  cannot distinguish a shrunken population from a covered one. One of them
  (`class-probe-consumers`) is **provably hollow right now** — a substitution keeps it green while a
  real consumer exits coverage — and it reds on a *bare* dropout only because its derived count
  happens to sit exactly on its floor.

**Recommendation: content-derived derivation stays, content-derived *scoping* does not.** A guard may
derive its population from content — that is the only way to observe reality — but the derived set
must be asserted **equal to an independently declared one**, never merely counted. This is already the
shape of the healthiest guards in the package, now including the repaired `adoption-lint`. Promoting
it to a repo-wide convention changes a convention, so per #4509's AC it is **routed as a decision
follow-up**, not decided here.

## Method

**Criterion.** A guard/test is in the class iff (a) it reads bytes from the **live repo corpus** (not
a fixture), (b) it derives a **set of subjects** from those bytes by a `.filter` / `.test` / grep, and
(c) it then makes a **per-member positive assertion** over that set. A guard that merely *scans for
violations* (empty result = pass) is a different class — that is the read-surface family of #4470 /
#4486 / #4496 / #4498, and its fail-closed answer is ADR 0092 zero-scope, already applied.

**Enumeration.** Reproducible over `main`:

```bash
grep -rln 'import.meta.url' packages/pipeline-cli/src --include='*.test.ts'   # 31 live-corpus candidates
grep -rn  '\.filter(\|\.some(\|\.every(' packages/pipeline-cli/src --include='*.test.ts'
grep -rn  'toBeGreaterThan(0)\|isAbove(.*, 0)' packages/pipeline-cli/src --include='*.test.ts'
grep -rln 'matchAll\|\.match(' packages/pipeline-cli/src/tools --include='*.ts'  # guard cores
```

Each hit was then read and classified against the criterion. 27 of the 31 live-corpus candidates
turned out to be **fixture-scoped** (they build their corpus in a `mkdtemp` and assert on it), which
is out of the class by construction: a fixture cannot lose a file to extraction.

**Negative probes.** Every verdict below marked *measured* comes from re-running the guard's own
derivation over an **in-memory mutated copy** of the corpus and observing whether its assertions red —
not from reading the filter. Nothing on disk was mutated. The probe scripts are reproduced at the end
so the measurements can be re-run.

## The inventory

### A. Content-derived subject populations — the #4509 class

| # | Guard / pin | Population derived from | Anti-shrink mechanism today | Verdict |
|---|---|---|---|---|
| A1 | `src/tools/adoption-lint/command.test.ts` — the #4015 claim-ordering pin | each writer's surface filtered by `LAYER_ONE_ANY_WRITE.test(content)` | **now** `deepStrictEqual(derived, LAYER_ONE_WRITING_FILES)` | **Repaired on `main` by #4503** — before that repair its floor was `isAbove(…, 0)`, which did *not* red on the dropout; a neighbouring declared-population pin did (measured) |
| A2 | `src/tools/class-probe/class-probe-consumers.unit.test.ts` — `SITES` | every runnable-fence statement containing `class-probe classify --namespaces` | `expect(SITES.length).toBeGreaterThanOrEqual(3)` | **Hollow by substitution, measured** — repaired in this PR |
| A3 | `src/subprocess-budget.test.ts` — `spawningTestFiles()` | test files whose source matches `^import … from "node:child_process";$` | `expect(…length).toBeGreaterThan(0)` over **21** members | **Dropout entirely invisible, measured** — repair deferred (§CP, see below) |
| A4 | `src/pipeline-cli-shim.hook.test.ts` — the `usesShim` floor | `.md` files under `skills/` whose text matches `bin/pipeline-cli` | `.some(...)` over **8** matching files | **Dropout entirely invisible, measured** — repair deferred (§CP, see below) |

#### A1 — `adoption-lint`'s #4015 ordering pin (the instance #4509 was filed on)

**Now repaired on `main`.** PR #4503 merged mid-investigation (`b015fa48`) carrying both halves: a
sibling-scoped `writerSurface` (the file plus the `scripts/*.sh` beside it) *and* — the part that
matters here — a declared `LAYER_ONE_WRITING_FILES` list asserted `deepStrictEqual` to the derived
population, whose failure message names the drift explicitly. Its docblock cites #4509 and states the
residual precisely: sibling-scoping still leaves `shared/scripts/**` outside the surface, so
"extracting a write into the shared lib drops that file out of the ordering scope silently — the same
class reproducing inside its own remedy", and it is the **declared membership**, not the widened
surface, that makes that drop-out red. That is the ticket's recorded third face, closed.

The pre-repair measurement is retained because it is the report's central evidence. Against the
pre-#4503 base, population was **3 of 3** declared claim writers; the probe relocates `claim assign`
out of `claude-plugins/kampus-pipeline/skills/write-code/SKILL.md` into a sourced `scripts/*.sh` (the
exact move #4503 performs) and re-derives:

```
main, unmutated:
    #4015 ordering-pin population: 3/3
    #4015 floor (population > 0): GREEN
    sibling #4298 declared-population pin: GREEN
write-code's `claim assign` relocated into scripts/*.sh:
    #4015 ordering-pin population: 2/3   ← write-code exits the population
    #4015 floor (population > 0): GREEN  ← the pin's own guard does NOT red
    sibling #4298 declared-population pin: RED — …/skills/write-code/SKILL.md
```

The loss **was** caught at that base — by the `#4298` "writes layer one through the one verb" pin,
which asserted the same regex over the **declared** `CLAIM_WRITERS` list rather than over a filtered
subset. That is the recommendation demonstrated empirically on the very instance the ticket names: the
declared-population shape reds, the content-scoped shape does not. It also explains why the loss went
*fully* silent on #4503's branch mid-flight — that PR widens the neighbouring pin's surface too, so for
a window the only remaining guard was the count floor. The merged version replaces that floor with the
membership equality above, which is why A1 needs no further repair here.

#### A2 — `class-probe-consumers` (repaired here)

Derived population on `main` is **exactly 3 sites in 2 files**, against a floor of `>= 3`:

```
baseline: n=3 floor(>=3)=GREEN
    claude-plugins/kampus-pipeline/agents/reviewer.md:157
    claude-plugins/kampus-pipeline/agents/reviewer.md:259
    claude-plugins/kampus-pipeline/skills/ship-it/scripts/step2-verdict-gate.sh:25
drop ship-it consumer: n=2 floor(>=3)=RED
drop ship-it + substitute a decoy: n=3 floor(>=3)=GREEN   ← ship-it's consumer is unchecked
```

The middle row is the only reason this pin is not already hollow, and it holds by coincidence: the
count sits *on* its floor. The third row is the class firing today — one real consumer exits coverage,
the floor is satisfied by any other site, and the run is green. The moment a fourth consumer is added
the middle row goes green too and the pin is permanently unable to see a dropout.

**Repaired in this PR** by declaring the population and asserting set equality (see *What changed*).

#### A3 — `subprocess-budget`

21 members derived from an import statement. The floor is `> 0`, so **20 of 21 could drop out** and
the suite stays green. This is not hypothetical for this population specifically: the tier's membership
signal is `import … from "node:child_process"`, and extracting a suite's `execFile` wrapper into a
shared helper — an ordinary refactor, and the exact shape the extraction programme performs on shell —
removes the import from the test file and silently drops the file out of the tier that enforces its
timeout budget. The failure then reappears as the #4014 false-red-under-load this guard exists to
prevent.

#### A4 — `pipeline-cli-shim`'s `usesShim` floor

`.some()` over 8 matching files. Documented in-file as a "sanity floor", and as a floor it is honest —
but it is the *only* thing standing behind the offender scan above it, and it is `.md`-only while the
corpus it backs includes `.sh`. A shrink from 8 to 1 is invisible.

### B. Content-derived populations that are already declared-anchored — the exemplars

These read the same live bytes but pin the derived set against an **independent declaration**, so a
dropout reds. They are the evidence that the recommended shape is already the repo's own idiom, not a
new invention.

| # | Guard | Derived from content | Declared counterpart | Verdict |
|---|---|---|---|---|
| B1 | `src/tools/fanout-guard/fanout-guard.ts` (ADR 0155) | `Fate.mutation` keys discovered in each feature's `mutations.ts` | `fanned-mutations.ts` manifest rows | **Unaffected.** `judge`'s `drift` invariant fails on `unclassified` *and* on `stale` — set equality in both directions — plus a `zero-scope` refusal |
| B2 | `src/tools/control-plane-paths/core-import-closure.unit.test.ts` (ADR 0218) | the import graph walked out of the §CP core | `ALLOWED_ESCAPES` literal | **Unaffected.** `expect(escapingModules()).toEqual(ALLOWED_ESCAPES)` |
| B3 | `src/gate-boundaries.unit.test.ts` (#4401) | — | `FIXTURES` names vs `Object.keys(GATE_BOUNDARIES)` | **Unaffected.** A new exported boundary without a fixture pair reds |
| B4 | `src/tools/codeowners-cp/codeowners-cp.unit.test.ts` | uncovered §CP paths; `CONTROL_PLANE_RE` parsed off the on-disk formats doc | literal expected list; `LIVE_RE` | **Unaffected.** Both are equalities against a declaration |
| B5 | `src/tools/adoption-lint/command.test.ts` (as of #4503) | each claim writer's sibling-scoped surface filtered by `LAYER_ONE_ANY_WRITE` | `LAYER_ONE_WRITING_FILES` | **Repaired into this shape**, arrived at independently — see A1 |

### C. Checked and out of the class

- **Fixture-scoped** (27 files): `decisions-index/gate`, `design-token-guard/gate`,
  `design-inventory/gate`, `ship-digest/command.derive`, `changelog-derive/command.derive`,
  `pin-dispatch.hook`, `cli-invocation-guard.unit`, `eval-harness/corpus.data`, `scratchpad/*`,
  `worktree-*`, and the rest. They build a corpus in a temp dir; extraction cannot reach them.
- **Read-surface family, already repaired**: `cli-invocation-guard` (per-surface zero scope, #4486),
  `leak-guard`'s `DOC_SUFFIXES` (#4496), and the heading-slicing parsers `checks/step3-contract.ts` +
  `merge-queue-classify/step55-contract.ts`, which #4515 gave a file-following surface
  (`src/skill-shell-surface.ts`) and — importantly — re-pinned `parseMergeDispositions` against
  `MergeOutcome`'s four words, i.e. against an **independent source** rather than against the text it
  parses. That is the same remedy this report recommends, arrived at independently.

## The six faces, and what actually catches each

#4509 accumulated six mechanisms under one root cause — *a guard keeps passing while asserting less
than its reader believes*. They are not interchangeable, and a single mitigation does not cover them:

| Face | Mechanism | What catches it |
|---|---|---|
| 1 | File surface narrows (a file type leaves the read corpus) | Per-surface zero-scope fail-closed (ADR 0092, #4486) |
| 2 | Subject population shrinks (content moves out from under a filter) | **Declared-population equality** — the subject of this report |
| 3 | Predicate widens (a hoisted constant admits the forbidden form) | A predicate pinned against a positive *and* a negative fixture (`gate-boundaries.unit.test.ts`'s third check) |
| 4 | Assertion goes vacuous (`notInclude([], …)`, `"" === ""`) | An explicit non-triviality assertion on the **input**, separate from the assertion about it |
| 5 | An exclusion documented as redundant becomes load-bearing | Recording the *reason* for an exclusion, not the conclusion — a "this is redundant" claim expires whenever the pattern set widens |
| 6 | A bypass routes around a correct guard (`verdict gate --require`) | Out of scope here — its own p0 lane |

Faces 2 and 4 are the ones a population check and a predicate check respectively *cannot* catch for
each other, which is why the recommendation below has two clauses rather than one.

**The unifying test, which is cheap and mechanisable: can this assertion be satisfied by an empty or
absent subject?** If yes, it is vacuous and must fail closed instead. Note the corollary that made the
faces findable at all: **a row that cannot be made to fail by any mutation of what it claims to guard
is not a guard.** Every verdict in this report was produced by mutating and watching, never by reading
the filter — reading the filter is exactly what makes this class invisible.

## Recommendation

**Is content-derived self-scoping acceptable at all? Yes — but never as the sole source of the
population.** Deriving from content is how a guard observes reality, and replacing it with a hand-kept
list would just move the rot. What is unacceptable is *validating* that derivation with a count.

Concretely, three clauses:

1. **Declare the population; assert equality, not a count.** A content-derived subject set must be
   asserted **equal** to an explicitly declared set (or set-with-cardinality) that lives in the file.
   Both directions must red: a dropout *and* an unreviewed addition. This is `fanout-guard`'s `drift`
   invariant, `core-import-closure`'s `ALLOWED_ESCAPES`, and now `adoption-lint`'s
   `LAYER_ONE_WRITING_FILES` — three lanes that reached the same shape independently. The declaration edit is the
   point, not the cost — it is the moment a human consciously accepts the change, the same way
   `fanned-mutations.ts` forces the fanned/not decision.
2. **Assert the input is non-trivial before asserting about it.** Face 4 is not reached by clause 1 —
   the population can be intact while the assertion is vacuous on the value it received. Non-triviality
   belongs as its **own** assertion, so it can be read and inverted independently (the shape #4515 gave
   the Step 5.5 horizon row).
3. **Prefer an independent source for a pin over the text it guards.** A pin derived from the same
   content it guards cannot detect that content going missing (`parseMergeDispositions` pinned against
   `MergeOutcome`, #4515).

**This changes a repo-wide convention, so it is routed, not decided here** (#4509 AC 3). The
convention question — whether clauses 1–3 become a `.patterns/` rule with a mechanical enforcement
(the mutation-based check is mechanisable: mutate the corpus, list the rows that stayed green) or stay
per-guard judgement — is filed as a decision follow-up.

## What changed in this PR, and what did not

**Repaired (ADR 0070 bounded collapse):**

- `packages/pipeline-cli/src/tools/class-probe/class-probe-consumers.unit.test.ts` — the `SITES >= 3`
  floor is replaced by a `DECLARED_CONSUMERS` map (file → site count) asserted **equal** to the derived
  one, plus a separate non-empty-declaration assertion so the equality itself cannot go vacuous. Both
  are red-able: raising a declared count reds naming the file and both counts; emptying the declaration
  reds both rows.

**Deliberately not repaired here, and why (#4509 AC 4):**

- **A3 / A4** (`src/subprocess-budget.test.ts`, `src/pipeline-cli-shim.hook.test.ts`). Both sit at
  `packages/pipeline-cli/src/`'s non-recursive root, which `CONTROL_PLANE_RE` matches — so folding them
  in would change the **merge authority of this whole PR** to §CP and park an otherwise-ordinary class
  fix behind a human approval. That is a structural bound, not a size one. Filed as a §CP-lane
  follow-up carrying the exact patch shape.
- **A1** (`adoption-lint/command.test.ts`) — no repair needed: PR #4503 landed it mid-investigation.
- **The mechanised mutation check** across the suite — a new tool, well beyond bounded collapse. Filed.

## Reproducing the probes

The three probe scripts are pure reads over the working tree; each re-runs a guard's own derivation
over an in-memory mutated copy and prints the population plus whether the guard's floor stays green:

- **A2** — walk `claude-plugins/kampus-pipeline` for `.md`/`.sh`, re-run
  `class-probe-consumers.unit.test.ts`'s fence walk and `NAMESPACE_READ` match, under three mutations:
  identity; neuter `ship-it/scripts/step2-verdict-gate.sh`'s read; neuter it *and* duplicate a
  compliant `reviewer.md` site. Compare each against `length >= 3`.
- **A3** — re-run `subprocess-budget.test.ts`'s `CHILD_PROCESS_IMPORT` filter over
  `packages/pipeline-cli/src`, and evaluate `length - 1 > 0`.
- **A1 / A4** — re-run `adoption-lint`'s `LAYER_ONE_WRITE` filter over `CLAIM_WRITERS` with
  `write-code/SKILL.md`'s `claim assign` rewritten to a sourced-script reference, reporting both the
  filtered population's floor and the sibling declared-population pin; and count `usesShim`'s matches.
