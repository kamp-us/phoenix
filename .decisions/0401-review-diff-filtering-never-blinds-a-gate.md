---
id: 0401
title: Review diff filtering is deterministic, enumerated, and never blinds a gate
status: proposed
date: 2026-09-20
tags: [fabrika, review, benchmarks, governance]
---

# 0401 — Review diff filtering is deterministic, enumerated, and never blinds a gate

**What this decides:** deterministic diff filtering enters `review scope` and `review diff` as
noise-class exclusion with three standing invariants and one refused shape: exclusions are never
silent (enumerated in scope output and a machine-readable diff header), requirement-deriving
consumers keep reading the raw path list, a read-only `review preview` verb shares the
derivation, and a filter that would blind a governed surface is refused rather than narrowed.
usirin endorsed the RFC in person on 2026-09-19 — relayed by Baris Eroglu on 2026-09-20, with no
on-thread comment; this ADR is the citation of record — and asked for a draft PR linked on
[discussion #9199](https://github.com/kamp-us/phoenix/discussions/9199) for review. The
endorsement covers the direction as posted; it picks no filter placement, so field 1 below stays
an open ruling. This ADR is `proposed` until its landing PR merges.

## Context

The OCR-port investigation (local benchmark, 2026-09-12/13) tested which of three
open-code-review-style mechanisms survive measurement on this repo's own history: deterministic
diff filtering, a pre-flight scope-preview verb, and path-to-rule subsystem fragments. Only the
first two are this ADR's subject; the third stays with the discussion as a separate proposal.

The order of work was benchmark-before-contract, deliberately. Every prior filter-shaped proposal
in this repo's orbit died on an unmeasured premise, so the filtering feature was built as a local
spike (branch `spike/ocr-port-filter-placement`, reference only, never merged) behind a
nine-PR benchmark manifest drawn mechanically from six months of merged PRs, blind-labeled, and
adjudicated by the founder before any contract text was written. The architecture fact the whole
design rests on already existed: the consumer split. Requirement-deriving consumers
(`touchesGovernanceRoot`, `ship scope`, `lane prove`, the portability guard's triggers) read the
raw changed-path list; only content-delivery consumers (`review diff`, preview) would read a
filtered one. A review-side exclusion therefore cannot dodge a gate — the guards never see the
filtered list to be blinded by it.

What measurement changed was the motivation and the refusal design. The token case died: the
default exclusion set matches content on 1 of 9 sampled PRs, so filtering is economically
irrelevant here. What survived is semantic — the one excludable hunk was real noise the reviewer
read as code context, and the dependency-PR question (what a contract-less, all-excluded diff
*means* to the merge gate) is real regardless of token counts. And the draft's defense-in-depth
refusal — refuse any exclude pattern intersecting `governedRoots` union guard trigger trees —
misfired on its own motivating population: on real dep-only PR #399, excluding a package.json
glob refused at exit 17 because it grazed catalog-guard's corpus, blocking a legitimate policy
choice about review scope on the exact PR class the filter exists to serve.

## Measured evidence

Numbers are cited exactly as measured; sources are the benchmark artifacts
(`benchmarks/ocr-port/`, landing under `reports/` with the epic — see Records).

- **Corpus.** Every merged PR from the last six months classified by changed-file paths
  (n=2,852): exactly **two** dependency-only, **zero** touching only `pnpm-lock.yaml`. The
  default exclusion set (lockfiles, snapshots, generated artifacts) matches content on **1 of 9**
  sampled PRs.
- **Token profile (o200k_base, exact counts, scaffold trimmed so N=0 runs drop the scope-rows
  block).** Strictly non-negative: **unchanged +43 tokens** (a fixed filter header, under half a
  percent of prompt even on the smallest PR) on the eight PRs with nothing to exclude; **-804
  (Branch A) / -803 (Branch B)** on #535, the one PR carrying a lockfile hunk; **net -460 (A) /
  -459 (B)** across the nine-PR sample. On the eight zero-exclusion PRs the two placements are
  token-identical — the only content difference is the placement marker inside the exclusion
  scaffold, which is dropped when nothing is excluded.
- **The #399 refusal misfire.** Under the over-broad union, `--exclude '**/package.json'` on real
  dep-only PR #399 refused at exit 17 (GOVERNED_FILTER). The glob was a probe of the refusal
  path, not a proposed default; the proposed defaults remain lockfiles, snapshots, and generated
  artifacts.
- **The placement fork, on a real all-excluded PR.** With the probe accepted, #399 becomes
  all-excluded and the two placements demonstrably diverge: Branch A (filter before namespace
  derivation) derives zero namespaces — nothing owed by the gate, exclusion still enumerated in
  scope/preview output; Branch B (filter after) keeps `namespace review-code` beside
  `excluded 1 -- packages/epic-ledger/package.json`.

## Benchmark methodology

- **Blind labeling.** Verdicts were produced from skill text + diff only — no commit messages, no
  review comments, no CI/governance arms. Verdicts are proxies: single samples with no error bars,
  and on eight of nine PRs the reviewed input is byte-identical across arms, so any verdict cell
  there is harness variance, not filter effect (observed: one clean PR's defect flag flip-flopped
  true/false/true across the three arms on identical input).
- **Two-field adjudication.** Ground truth splits into `adjudicated_code_defect` (is the defect
  real) and `diff_visible` (could a diff-only read catch it). The alternative — relabeling the
  missed defect to `no-defect` after seeing the miss — was inadmissible: outcome-informed, i.e.
  the motivated-scoring failure the adjudication gate exists to prevent.
- **Sample stated plainly.** n=9, confirmed-defect n=2, dep-only n=0. The safety claim is "zero
  *new* false negatives" and it is weakly powered: on eight PRs the inputs are unchanged so no
  filter effect is possible; on #535 the input changed and the defect flag held in both
  placements. Per-arm flag-vs-adjudication was baseline 7/9, Branch A 8/9, Branch B 7/9 —
  per-arm differences on unchanged-input PRs are harness variance; the only filter-attributable
  cell is #535.
- **Survivorship bounds.** The six `no-defect` rulings mean "no pipeline record of a defect and
  nothing in spot-checks", not proven absence.

## Provenance

Carried verbatim from the adjudication sheet: the rulings are human (Baris Eroglu). The
verification reads were executed directly in-session by the working agent — no subagent
intermediary; the raw commands and their output are in the session transcript, and the
load-bearing ones are reproduced below so any maintainer can re-run them in under a minute. This
is **"human-adjudicated with agent-executed verification reads"** — not literal eyes-on-by-human.

```
# #4015: #4503 removes the floor, adds declared-population equality (expect 3, then 4)
git show b015fa48 -- packages/pipeline-cli/src/tools/adoption-lint/command.test.ts | grep -cE '^-.*isAbove'
git show b015fa48 -- packages/pipeline-cli/src/tools/adoption-lint/command.test.ts | grep -cE '^\+.*(LAYER_ONE_WRITING_FILES|deepStrictEqual)'
# #535: the three flagged findings are in the bytes at the pinned SHA (expect the stub, the pin, the claim)
git show ce3a14cfe2 -- packages/preview-seed/src/d1-rest.ts | grep -n 'success: true'
git show ce3a14cfe2 -- pnpm-workspace.yaml | grep 'distilled'
git show ce3a14cfe2 -- packages/preview-seed/README.md | grep -n 'no new Cloudflare'
```

**Slot — activates only on the adjudicator's confirmation.** If the five commands above are
re-run by Baris and confirmed, this section upgrades to "adjudicator verified the scored-set
evidence directly." This draft does not activate it itself.

## Decision — four sub-fields: three carried as recommended, placement open

usirin's in-person endorsement covers the direction, not the individual fields. Fields 2–4 carry
the RFC's recommendations into this ADR unchanged; field 1 is the placement product question the
RFC deliberately left open and no one has ruled on it yet. Each field records the RFC's
recommendation and the measured evidence for it.

1. **Filter placement — OPEN (#9199 Q1).** The RFC poses before-derivation (Branch A) vs
   after-derivation (Branch B) as an open question and leaves it open: both branches are
   demonstrated viable, token-equivalent (identical on 8 of 9 PRs, one token apart on #535). The
   decision sets what a contract-less, all-excluded diff *means* to the merge gate — zero
   namespaces owed (A) versus namespace rows beside a deliberate-exclusion enumeration (B) — and
   with it how dep-only PRs flow through review.
2. **Consumer split — as recommended by #9199 (Q2).** RFC recommendation: requirement-deriving consumers
   read raw paths, content-delivery consumers read filtered paths. This is the least contested
   field — the split already exists in the code, and the golden guard-corpus test documents the
   trees it protects.
3. **The `excluded` scope row — as recommended by #9199 (Q3; its shape depends on the placement
   ruling).** RFC
   recommendation: adopt the `routed`-style `excluded` row over introducing any new terminal
   state, so an all-excluded diff reads as "something was there and was excluded on purpose",
   distinct from truncation.
4. **Narrow the refusal union to `governedRoots` only — as recommended by #9199 (Q4).** RFC recommendation:
   guards do not need the union's protection because they read the raw path list (field 2), so
   narrowing adds no risk; the measured cost of keeping the guard trees in the refusal union is
   the #399 misfire — refusing the exact PR class the filter exists to serve. Guard trees stay
   documented and drift-loud by the golden test.

## Consequences

If accepted, with fields 2–4 landing as recommended and a placement ruling picked for field 1:

- **Changes:** `review scope` enumerates exclusions (`excluded` / `excluded-path` rows, JSON
  counterparts) whenever filtering is active; `review diff` emits machine-readable headers
  (`x-fabrika-filter: placement=… excluded=N served=M`, one `x-fabrika-excluded-path:` line per
  excluded path) strictly after its completeness proof; a read-only `review preview` verb shares
  the derivation with zero LLM turns; the refusal union narrows to `governedRoots` on a dedicated
  exit code; new config-key fragments under `review.*` carry the defaults, the declared extend-set
  and the removal list (`reviewFilterExclusions` / `reviewFilterUnexclude`), with a removal of a
  default enumerated in the scope output (`un-excluded` rows) rather than silent.
- **Does not change:** guards keep reading the raw path list — no gate's requirement derivation
  ever sees a filtered list; the acceptance-criteria gate and every namespace rule are untouched;
  unfiltered invocations are byte-identical to today's output.
- **Recorded as rejected:** the token-cost motivation (measured roughly neutral — the RFC publishes
  the numbers and does not claim it); silent exclusion in any form (the enumeration invariant is
  the feature's first invariant, not a later patch).

## Alternatives considered

- **Keep the over-broad refusal union** — rejected: it misfires on its motivating population
  (#399), and the protection it intends is already delivered by the consumer split plus the
  golden test.
- **Branch B only, no fork question** — viable and pending: the fork question exists because the
  two placements differ in gate semantics on all-excluded diffs, which is a product question
  about dep-only PRs, not a mechanics one.
- **Do nothing** — rejected: the token case is dead but the semantic case survives measurement —
  real noise read as code context (#535), and a contract that demonstrably does not serve the
  dep-only PRs it already receives (both in-frame dep PRs carry no verifiable acceptance-criteria
  block).

## Records

- [Discussion #9199](https://github.com/kamp-us/phoenix/discussions/9199) — the review venue;
  this ADR's four fields map to its four questions. usirin endorsed the thread in person on
  2026-09-19 (relayed by Baris Eroglu, 2026-09-20); the landing draft PR is linked on the thread
  as its record.
- The OCR-port benchmark artifacts (manifest, baseline, both treatment arms, adjudication sheet)
  land under `reports/` with the epic's first child; until then they live untracked in
  `benchmarks/ocr-port/`. The claim ledger (`claim-ledger.mjs` — one numbered claim per posted
  figure, each re-derived from the artifacts and checked against the live posted text, 21/21 PASS
  2026-09-13) lands beside them and is cited here as the correspondence proof between the posted
  thread numbers and the repo's artifacts.
- The spike branch `spike/ocr-port-filter-placement` (commits `19009cec`, `ac16ae67`) is the
  implementation's origin — reference material, never merged. This PR carries the implementation
  itself, cherry-picked from the spike and resolved against main: `GOVERNED_FILTER` re-seated
  17 → 21 (main took 17–20), the design guards' corpus paths updated to `packages/design/`, and
  the diff parser made CRLF-tolerant. The `--filter-placement` flag carries BOTH placements while
  field 1 stays open; the shipped default collapses to the placement the ruling picks.
- 2026-09-20 — the PR came to carry all three of #9199's mechanisms, not only the filter. Baris
  Eroglu directed the remainder land here with the placement still the maintainer's to rule:
  `review preview` gained its parity subjects (a PR number with optional `--sha`/`--repo`, and
  `--base`/`--tip`, each proving diff completeness before the filter exactly as `review diff`
  does); mechanism 3 — until now held as a separate proposal — landed as the `reviewSubsystems`
  config key, whose glob matches resolve over `review scope`'s output as additive
  `subsystem` / `subsystem-note` constraint rows layered onto the class rubrics, matched by the
  filter's own glob engine so a repo never learns two dialects; and the extend/remove surface
  (`reviewFilterExclusions` / `reviewFilterUnexclude`) completed mechanism 1's config story, with
  the `un-excluded` enumeration keeping a removal of a default visible and an equal-pattern
  re-addition deterministically winning over a removal. With both keys absent, every consumer's
  output is byte-identical to before they existed.
