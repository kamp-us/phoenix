# fabrika-cli doc surfaces, classified by Diátaxis quadrant

**Date:** 2026-08-29 · **Issue:** [#7296](https://github.com/kamp-us/phoenix/issues/7296) · **Epic:**
[#6713](https://github.com/kamp-us/phoenix/issues/6713)

A read-only pass. Every `packages/fabrika-cli` doc surface is named, given its dominant Diátaxis mode
with the one signal that decided it, and — where it serves a second reader — the intruding material
and the `.decisions/` file that already holds that material's why. **No cure is proposed and no
surface is edited.** This report is the cut list the sibling slices work from.

Classifier: [`claude-plugins/fabrika/skills/diataxis/SKILL.md`](../claude-plugins/fabrika/skills/diataxis/SKILL.md),
applied in its stated order — ordered sequence the reader performs → tutorial/how-to; else looked-up
and argument-free → reference; else → explanation.

## Scope, as counted

| Surface | Unit classified | Count |
|---|---|---|
| `packages/fabrika-cli/README.md` | preamble + every `##` / `###` section | 1 + 38 |
| `packages/fabrika-cli/src/capture/README.md` | preamble + every `##` / `###` section | 1 + 12 |
| `packages/fabrika-cli/src/*/command.ts` | the registered groups' description strings | 30 groups, 266 `withShortDescription` / `withDescription` pairs |

The 30 groups match [`packages/fabrika-cli/src/registry.ts`](../packages/fabrika-cli/src/registry.ts)
lines 54–83 exactly, and the 30 `src/*/command.ts` files are the same 30. Every group appears in
Table C.

## Table A — `packages/fabrika-cli/README.md`

| Section | Dominant mode + the signal | Intruding mode | The intruding material | Where that why lives |
|---|---|---|---|---|
| (preamble, L1–11) | reference — it states what the package is and declares itself "the verb reference" | explanation | the two-layer split ("deterministic work is pushed into CLI verbs, each skill a thin wrapper") | no decision holds this; the finding is [#4631](https://github.com/kamp-us/phoenix/issues/4631), cited only from `docs/interface-convention.md`. [ADR 0231](../.decisions/0231-decision-computing-logic-becomes-a-verb.md) holds the adjacent script/verb half |
| `## Install` | reference — a where-you-are/what-runs lookup table | explanation + how-to | the four rules arguing each row ("No outcome is both silent and wrong", "The property this buys"); the `pnpm add --global` line is a one-step recipe | [ADR 0287](../.decisions/0287-delegation-stays-inside-one-repository.md) holds the delegation why |
| `### The two Node floors` | reference — a two-row floor table a reader looks a version up in | explanation | why two floors exist, why `publishConfig` makes both true, the measured 22.11 / 20 / 18 evidence | no decision holds this |
| `### The one prerequisite: a GitHub token` | reference — the resolution order as a fact | explanation | why there is no `gh` prerequisite, why `gh auth token` is convenience-only | [ADR 0315](../.decisions/0315-fabrika-cli-github-token-resolution-and-the-three-non-rest-carves.md), already cited inline |
| `## Quickstart` | how-to — three invocations toward a goal the reader brought | explanation | the closing paragraph on the `--help` index being derived from the registry | no decision holds this; the why sits in `src/registry.ts`'s own docblock |
| `## The interface every verb meets` | reference — four contract rules to look up | explanation | every rule argues its case (byte-identical empty stdout, why `2` is allocated by nothing) | `claude-plugins/fabrika/docs/interface-convention.md`; the fail-closed rule is [ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md) |
| `### The shared exit table` | reference — a code/meaning table | explanation | the closing paragraph on a deliberate gap being kept rather than the number reused | no decision holds this |
| `## The adr group` | reference — purpose line, verb table, exit list | explanation | "Three behaviours are worth knowing" | no decision holds this |
| `## The build group` | reference — verb table + exit list | explanation | the `reap` vs `retire` comparison paragraph | no decision holds this |
| `## The ci group` | reference — verb table + exit list | explanation | "Two things here do not follow the ordinary verb shape, and both are forced" | [ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md) for `ci-required`; [ADR 0054](../.decisions/0054-run-evidence-bundle.md) and [ADR 0069](../.decisions/0069-derived-changelog-from-shipped-work.md) cited inline for the verbs |
| `## The config group` | reference — one verb, its stdout grammar, its own exit table | explanation (light) | "kept rendered … rather than hand-synced"; exit `7`'s "would green a typo under it" clause | no decision holds this |
| `## The decision group` | reference — verb table + exit list | explanation | the opening paragraph on why the group exists, and the `rule`-derives-its-own-digest paragraph | [ADR 0289](../.decisions/0289-founder-approves-every-epic-plan.md), named in the README without a link; [ADR 0055](../.decisions/0055-acl-sourced-review-authz.md) governs the roster read |
| `## The glossary group` | reference — verb table + exit list | explanation | "Three behaviours are worth knowing" + the closing no-network line | no decision holds this |
| `## The governance group` | reference — verb table + exit list | explanation | the namespace definition paragraph and "Three behaviours are worth knowing" | no decision holds the §CP-is-CODEOWNERS-only claim; its home is `docs/control-plane-classification.md` |
| `## The graduate group` | reference — verb table + exit list, argument-free | — | single-mode | n/a |
| `## The grill group` | reference — verb table + exit list | explanation | "Three behaviours are worth knowing" + the four-frontier-tokens closer | [ADR 0055](../.decisions/0055-acl-sourced-review-authz.md), cited inline for the ACL bullet |
| `## The guard group` | reference — a 20-row guard table + exit list | explanation + how-to | "Three things are shared by the group rather than rebuilt per guard"; the `guard readme-guard check` fenced block is a reproduce-the-red recipe | [ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md) and [ADR 0132](../.decisions/0132-merge-queue-for-base-freshness.md), both cited inline |
| `## The handoff group` | reference — verb table + exit list | explanation | "Four behaviours are worth knowing" + the closing nothing-here-blocks-a-merge line | no decision holds this |
| `## The heal-ci group` | reference — verb table + exit list | explanation | "Six behaviours are worth knowing" | [ADR 0205](../.decisions/0205-orphan-red-prs-convert-to-board-work.md) and [ADR 0228](../.decisions/0228-scripts-relay-never-derive.md), cited inline in two of the six bullets |
| `## The hook group` | reference — verb table + exit list | explanation | the three closing bullets on captured fields, the one writing verb, and the retired spawn hook | [ADR 0180](../.decisions/0180-capture-real-runtime-artifact-before-coding.md), [ADR 0331](../.decisions/0331-fabrika-spawn-hook-retired.md), [ADR 0337](../.decisions/0337-worktree-provisioning-rehomed-onto-repo-settings.md), all cited inline |
| `## The lane group` | reference — verb table + a 40-code exit list | explanation + how-to | "Three behaviours are worth knowing"; the `mkdir` / `cp` / `transition` fenced block is an ordered open-a-lane recipe | no decision holds this; ADR 0285 (the epic-run shape) is not cited here |
| `## The ledger group` | reference — verb table + exit list, argument-free | — | single-mode | n/a |
| `## The map group` | reference — verb table + exit list | explanation | "Five behaviours are worth knowing" + the closing `404`-is-a-verdict paragraph | no decision holds this |
| `## The pattern group` | reference — verb table + exit list | explanation | "Four behaviours are worth knowing"; the closing paragraph then returns to flag reference | no decision holds this |
| `## The plan group` | reference — verb table + exit list, argument-free | — | single-mode | n/a |
| `## The recipe group` | reference — verb table + exit list | explanation | the recipe definition paragraph and "Known clears, novel escalates, and both are exit codes" | [ADR 0228](../.decisions/0228-scripts-relay-never-derive.md), cited inline |
| `## The report group` | reference — verb table + exit list | explanation | "Six behaviours are worth knowing" + the closing no-type-no-priority paragraph | no decision holds this |
| `## The review group` | reference — verb table + exit list | explanation | the six closing bullets (unreadable-response refusals, imported modules, the derived scratch nonce) | [ADR 0055](../.decisions/0055-acl-sourced-review-authz.md) and [ADR 0079](../.decisions/0079-reviewer-authored-acceptance-criteria.md) cited inline for two verbs, not for the bullets |
| `## The review-ui group` | reference — verb table + exit list, argument-free | — | single-mode | n/a |
| `## The ship group` | reference — a 15-verb table + exit list | explanation | the four closing bullets (§CP derived from CODEOWNERS, three modules extended, why `17` is loud, the GraphQL carve) | [ADR 0175](../.decisions/0175-cp-self-approval-cardinality-check.md), [ADR 0198](../.decisions/0198-no-parked-merge-intent.md), [ADR 0315](../.decisions/0315-fabrika-cli-github-token-resolution-and-the-three-non-rest-carves.md), all cited inline |
| `## The spend group` | reference — verb table + exit list | explanation | "Three behaviours are worth knowing" (cache-read share, never-a-zero, cannot gate) | [ADR 0112](../.decisions/0112-token-measurement-no-quality-compromise-methodology.md), cited inline |
| `### The spend ledger` | reference — the ledger's row shape and stdout grammar | explanation + how-to | "Three things about that output are load-bearing"; two fenced `spend rollup` invocations are a recipe | [ADR 0308](../.decisions/0308-bounded-evidence-output-shape.md), cited inline for the bounded-breakdown rule |
| `## The spike group` | reference — verb table + exit list | explanation | "Four behaviours are worth knowing" + the closing near-total paragraph | [ADR 0055](../.decisions/0055-acl-sourced-review-authz.md), cited inline for the capture-author bullet |
| `## The status group` | reference — a fenced verb list + exit list | explanation | "Three things are load-bearing" + the closing six-tier roster paragraph | no decision holds this |
| `## The triage group` | reference — verb table + exit list | explanation | the `repair-criteria` will/won't paragraph and "Three properties of the substrate are worth knowing" | [ADR 0159](../.decisions/0159-never-auto-close-signal-is-the-report-footer.md) cited inline for exit `13`; nothing holds the substrate bullets |
| `## The ui group` | reference — a fenced verb list + exit list | explanation | "Four things are load-bearing" + the closing guard/evidence paragraph | no decision holds this |
| `## The wire group` | reference — verb table + its own exit table | explanation + how-to | "Five behaviours are worth knowing"; the closing `wire emit` → `wire check` pipeline is a worked recipe | no decision holds this |
| `## The capture machinery` | reference — what the subpath is and what it exports | explanation | "Three consequences worth knowing before you install it" | [ADR 0183](../.decisions/0183-golden-screen-storage-depo-git-pointer.md) and [ADR 0201](../.decisions/0201-pipeline-tenant-phoenix-first.md), cited inline |
| `## Development` | explanation — it exists to make a contributor understand the architecture (pure verb cores, injected platform services, the two named raw boundaries) | how-to + reference | the three-command fenced block; the no-build-step paragraph | [ADR 0238](../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md) and [ADR 0271](../.decisions/0271-one-compiler-effect-patched-tsc.md) cited inline; nothing holds the pure-verb-core rule, which is `.patterns/`-shaped material |

**Table A totals:** 39 units. 4 single-mode (`graduate`, `ledger`, `plan`, `review-ui`), 35 mixed.
Host mode is reference in 37 of 39; `## Development` is the one explanation host. The intruding mode
is explanation in 34 of the 35 mixes; how-to intrudes in 6 (`Install`, `guard`, `lane`,
`The spend ledger`, `wire`, `Development`). `Quickstart` is the one how-to host, and it too is mixed.

## Table B — `packages/fabrika-cli/src/capture/README.md`

| Section | Dominant mode + the signal | Intruding mode | The intruding material | Where that why lives |
|---|---|---|---|---|
| (preamble) | reference — what the helper is and what it does not do | explanation | the "it does not judge / does not serve the app" boundary argument | [ADR 0165](../.decisions/0165-review-design-gate.md), cited inline |
| `## Why it lives in fabrika` | explanation — the heading asks why, and the body is a ruling's reasoning | reference | the sharp machinery/data line and the `golden-pointer.json` path | [ADR 0201](../.decisions/0201-pipeline-tenant-phoenix-first.md) §3, cited inline; the move itself rests on the [#5061](https://github.com/kamp-us/phoenix/issues/5061) ruling, not on any ADR |
| `## Why it exists` | explanation — pure rationale, no fact to look up | — | single-mode | [ADR 0162](../.decisions/0162-four-pillars-design-law.md) and [ADR 0165](../.decisions/0165-review-design-gate.md), cited inline |
| `## The module contract (the seam #2246 codes against)` | reference — the exported signatures and record fields | explanation | the per-export why clauses (why `resolvePreviewUrl` keys off the app anchor, why `Malformed` splits from `NoApp`) | [ADR 0058](../.decisions/0058-sha-bound-verdict-contract.md) cited inline for the SHA-mismatch refusal; nothing holds the rest |
| `## localPath is the primary judged artifact` | explanation — it argues one invariant and its correctness history | — | single-mode | no decision holds this |
| `## A thrown render exception fails the gate` | explanation — it argues a gate rule from the #2593 incident | reference | the `pageerror` vs `console.error` classification stated in prose | no decision holds this; [#2594](https://github.com/kamp-us/phoenix/issues/2594) is the finding |
| `## The golden-baseline seam` | reference — the exported cores and the pointer shape | explanation | the flake-canon split, the "one notion of golden, never two" argument | [ADR 0183](../.decisions/0183-golden-screen-storage-depo-git-pointer.md), [ADR 0144](../.decisions/0144-depo-internal-asset-cdn.md), [ADR 0108](../.decisions/0108-hand-authored-flat-d1-migrations.md), all cited inline |
| `### Re-bless via the CLI (the audited pointer move)` | how-to — an ordered bless recipe with a worked argv | explanation | the closing "`golden-bless` is pure + fs … provably the same content address" paragraph | [ADR 0183](../.decisions/0183-golden-screen-storage-depo-git-pointer.md) §5, cited inline |
| `## The candidate-render step` | reference — the three modules and their contracts | how-to + explanation | the `render-candidates` fenced invocation; the "does not bless" boundary argument | [ADR 0183](../.decisions/0183-golden-screen-storage-depo-git-pointer.md) §5 and [ADR 0045](../.decisions/0045-kampus-client-cli.md), cited inline |
| `## The blessing surface` | reference — the three exported functions and their folds | how-to + explanation | the two-step fenced gallery/bless recipe; the no-re-render guard argument | [ADR 0183](../.decisions/0183-golden-screen-storage-depo-git-pointer.md) §5, cited inline |
| `## The undocumented endpoint + the fallback (load-bearing)` | explanation — it argues why a fragile endpoint is acceptable | reference | the enumerated failure classes that degrade to `{hostedUrl: null, uploadError}` | [ADR 0165](../.decisions/0165-review-design-gate.md) "Evidence hosting" and [ADR 0144](../.decisions/0144-depo-internal-asset-cdn.md), cited inline |
| `## CLI` | how-to — one worked invocation to a real result | reference | the stdout shape and the `$GITHUB_TOKEN` handling note | no decision holds this |
| `## Tests` | how-to — the command to run | explanation | why there is no integration tier | no decision holds this |

**Table B totals:** 13 units. 2 single-mode, 11 mixed. Hosts split 5 reference / 5 explanation /
3 how-to — a page-level mix on top of the per-section one, which is the sharpest structural finding
on this surface: the file interleaves reference, why-pages and runnable recipes at one heading level.

**A second finding on this file, stated because it changes what any cure can assume:** the fenced
invocations in `### Re-bless via the CLI`, `## The candidate-render step`, `## The blessing surface`
and `## CLI` all run `node packages/design-capture/src/bin.ts …`, a bin the file itself says was
deleted unused ([#6346](https://github.com/kamp-us/phoenix/issues/6346)). They are how-to shaped and
not runnable. The file is explicit that they survive "as the worked shape", which is reference
material wearing a recipe's clothes.

## Table C — the registered verb descriptions

One row per registered group. `Pairs` counts that group's `Command.withShortDescription` /
`Command.withDescription` pairs, the group's own parent command included. Both string kinds were
extracted paren-balanced from each `src/<group>/command.ts`, so template literals and concatenations
are counted, not only plain quoted strings.

| Group | Pairs | Short description | Long description | Intruding material | Where that why lives |
|---|---|---|---|---|---|
| `adr` | 8 | reference | reference | 2 of 8 argue; 7 carry `Example:` | no decision holds this |
| `build` | 24 | reference (1 argues) | reference | 19 of 24 argue, 14 cite an issue or ADR — the heaviest explanation load in the package | no decision holds this |
| `campaign` | 4 | reference | reference | 3 of 4 argue, 2 cite | no decision holds this |
| `ci` | 5 | reference (1 argues) | reference | all 5 argue, 4 cite | [ADR 0054](../.decisions/0054-run-evidence-bundle.md), [ADR 0069](../.decisions/0069-derived-changelog-from-shipped-work.md), [ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md) |
| `config` | 2 | reference | reference | 1 argues | no decision holds this |
| `decision` | 3 | reference | reference | all 3 argue | [ADR 0289](../.decisions/0289-founder-approves-every-epic-plan.md) |
| `glossary` | 7 | reference | reference | 5 of 7 argue | no decision holds this |
| `governance` | 8 | reference | reference | 5 of 8 argue, 4 cite | no decision holds this |
| `graduate` | 5 | reference | reference | 4 of 5 argue | no decision holds this |
| `grill` | 6 | reference | reference | 3 of 6 argue | [ADR 0055](../.decisions/0055-acl-sourced-review-authz.md) |
| `guard` | 42 | reference (2 argue) | reference | 35 of 42 argue, 30 cite an issue or ADR — a guard's description carries its incident | [ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md) plus the per-guard ADRs cited in each string |
| `handoff` | 5 | reference | reference | 1 of 5 argues | no decision holds this |
| `heal-ci` | 9 | reference | reference | 8 of 9 argue, 4 cite | [ADR 0205](../.decisions/0205-orphan-red-prs-convert-to-board-work.md), [ADR 0228](../.decisions/0228-scripts-relay-never-derive.md) |
| `hook` | 4 | reference | reference | 1 of 4 argues | [ADR 0180](../.decisions/0180-capture-real-runtime-artifact-before-coding.md), [ADR 0331](../.decisions/0331-fabrika-spawn-hook-retired.md), [ADR 0337](../.decisions/0337-worktree-provisioning-rehomed-onto-repo-settings.md) |
| `lane` | 19 | reference | reference | all 19 argue, 13 cite; the longest single string in the package at 2623 chars | no decision holds this |
| `ledger` | 8 | reference | reference | 6 of 8 argue, 3 cite | no decision holds this |
| `map` | 9 | reference | reference | 5 of 9 argue | no decision holds this |
| `pattern` | 6 | reference | reference | 4 of 6 argue | no decision holds this |
| `plan` | 7 | reference | reference | 5 of 7 argue, 5 cite | no decision holds this |
| `recipe` | 4 | reference | reference | all 4 argue, 2 cite | [ADR 0228](../.decisions/0228-scripts-relay-never-derive.md) |
| `report` | 5 | reference | reference | 2 of 5 argue | no decision holds this |
| `review` | 10 | reference | reference | 9 of 10 argue, 5 cite | [ADR 0055](../.decisions/0055-acl-sourced-review-authz.md), [ADR 0079](../.decisions/0079-reviewer-authored-acceptance-criteria.md) |
| `review-ui` | 5 | reference | reference | 2 of 5 argue | no decision holds this |
| `ship` | 17 | reference | reference | 15 of 17 argue, 14 cite | [ADR 0175](../.decisions/0175-cp-self-approval-cardinality-check.md), [ADR 0198](../.decisions/0198-no-parked-merge-intent.md), [ADR 0315](../.decisions/0315-fabrika-cli-github-token-resolution-and-the-three-non-rest-carves.md) |
| `spend` | 3 | reference | reference | 2 of 3 argue | [ADR 0112](../.decisions/0112-token-measurement-no-quality-compromise-methodology.md), [ADR 0308](../.decisions/0308-bounded-evidence-output-shape.md) |
| `spike` | 6 | reference | reference | 2 of 6 argue | [ADR 0055](../.decisions/0055-acl-sourced-review-authz.md) |
| `status` | 8 | reference | reference | 6 of 8 argue | no decision holds this |
| `triage` | 13 | reference | reference | 8 of 13 argue | [ADR 0159](../.decisions/0159-never-auto-close-signal-is-the-report-footer.md) |
| `ui` | 6 | reference | reference | 4 of 6 argue | no decision holds this |
| `wire` | 8 | reference | reference | 5 of 8 argue | no decision holds this |

**Table C totals across the 30 groups:** 266 pairs. Every short description is single-mode reference
except 4 that argue. On the long side, 214 of 266 enumerate exit codes and 205 carry an `Example:`
invocation — both reference behaviour — while **193 of 266 (73%) carry rationale, and 105 (39%) cite
an issue number or an ADR inside the string a reader sees under `--help`.** Longest strings: `lane`
2623 chars, `ship` 2063, `review` 2038, `heal-ci` 1973, `recipe` 1917.

The uniform verdict is therefore **host reference, intruding explanation, on 30 of 30 groups**, with
`build`, `guard`, `lane`, `ship` and `heal-ci` carrying the heaviest load. The intruding material is
one shape everywhere: a why clause or an incident citation welded onto a fact, where the fact is what
a mid-task reader typing `--help` came for.

## Coverage gaps

A gap is a reader job no surface in scope serves, or a registered thing the README omits.

1. **`campaign` has no README section.** It is registered at
   [`packages/fabrika-cli/src/registry.ts`](../packages/fabrika-cli/src/registry.ts) line 56 and
   ships 4 description pairs in `src/campaign/command.ts`, and the README's 29 group sections do not
   include it. Registry 30, README 29. The README states that the `--help` index "is derived from
   `src/registry.ts` — a group appears by being registered and nowhere else", which is exactly the
   drift class a hand-maintained parallel list reintroduces; the README is that parallel list.
2. **No how-to anywhere under `packages/fabrika-cli/`.** Three sections are how-to shaped
   (`Quickstart`, `Development`, `capture/README.md ## CLI`) and each is mixed. The genuine
   human-facing recipes live outside the package, at
   [`claude-plugins/fabrika/guide/`](../claude-plugins/fabrika/guide/) — `getting-started.md`,
   `adopt-fabrika-in-a-new-repo.md`, `extend-the-wire-registry.md`, `delegation.md`,
   `how-fabrika-works.md`. The package README points there in its second paragraph. So the gap is
   precise: **the package carries no how-to of its own, and nothing in the package states that the
   how-to home is the guide beyond that one line.** The closest decision is
   [ADR 0134](../.decisions/0134-clis-agent-invokable-human-only-at-invocation-layer.md) (CLIs are
   agent-invokable by default), which explains why the package's reader is an agent — it does not
   rule where the human how-to lives.
3. **No tutorial anywhere in scope, and no surface claims one is owed.** Diátaxis's fourth quadrant
   is unserved by both READMEs. Whether one is owed at all is a decision nobody has recorded.
4. **`## The interface every verb meets` points one hop stale.** It links
   `claude-plugins/fabrika/docs/cli-interface-convention.md`, which is now a split-notice stub: the
   content moved to `interface-convention.md` and `contract-spec-format.md`
   ([#7021](https://github.com/kamp-us/phoenix/issues/7021)). The link resolves, so no guard reds; a
   reader lands on a redirect.
5. **`### The spend ledger` is missing from this issue's enumerated scope, and the enumeration's own
   count is off.** The issue names 34 README sections and lists `## Install` + 2 subsections,
   `## Quickstart`, `## The interface every verb meets` + `### The shared exit table`, 29 group
   sections, `## The capture machinery` and `## Development` — that list is 37 items, not 34, and it
   omits `### The spend ledger`. The live file carries 38 `##` / `###` headings: the 37 enumerated
   plus the one omitted. Table A classifies all 38 plus the preamble.
6. **The `capture` subpath has no exit-code or CLI-contract surface**, because it is a library
   subpath rather than a verb group — but its README still documents five
   `node packages/design-capture/src/bin.ts` invocations, across four sections, for a bin that was deleted
   ([#6346](https://github.com/kamp-us/phoenix/issues/6346)). A reader looking up "how do I bless a
   golden" gets an argv that runs nothing.

## Counts, as a checksum

| Fact | Value |
|---|---|
| Registered groups in `src/registry.ts` | 30 |
| `src/*/command.ts` files | 30 |
| Groups with a README section | 29 (`campaign` absent) |
| Groups in Table C | 30 |
| README `##` / `###` headings | 38 (+ preamble = 39 units) |
| `capture/README.md` headings | 12 (+ preamble = 13 units) |
| Description pairs classified | 266 |
| Units classified in total | 39 + 13 + 30 = 82 |
| Single-mode units | 6 (4 in Table A, 2 in Table B, 0 in Table C) |
| Mixed units | 76 |
