---
id: 0218
title: §CP on packages/pipeline-cli/ narrows to an enforcement core — amends ADR 0100's whole-package coverage
status: accepted
date: 2026-07-26
tags: [pipeline, control-plane, ship-it, codeowners, classifier, guards]
---

# 0218 — §CP on `packages/pipeline-cli/` is an enforcement core, not the whole package

## Context

The control-plane boundary (ADR [0053](0053-control-plane-boundary.md), enforced at GitHub per ADR
[0071](0071-enforce-control-plane-at-github.md), hard-gated per ADR
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)) marks the surfaces
where an autonomous green-then-ship merge could compromise the pipeline's own guards. Its concrete
form is the single-source `CONTROL_PLANE_RE` in
`control-plane-re.ts`,
its byte-synced copy in
`gh-issue-intake-formats.md`
§CP, and the matching `.github/CODEOWNERS` rows.

One of its branches was the blanket `^packages/pipeline-cli/`. That package now holds **68 tools**.
Most of them — `checks`, `main-sync`, `tracker`, `gh-phoenix`, `campaign`, `roadmap`,
`glossary-drift`, `decisions-index`, `design-inventory`, … — are coordination and read tooling that
gates nothing, yet every edit to any of them banked for a human control-plane approval.

**Measured cost.** Over the merge window 2026-07-25 → 2026-07-26, **23** of the merged PRs were §CP
*only* because of the `^packages/pipeline-cli/` clause. Under the core this ADR sets, **10** of them
would newly auto-ship. (The clause-attributable count is not the relief count: the rest touch a
retained core path and keep banking. Quote the 10, not the 23.)

**The founder's reasoning, which is the decision's actual basis.** He does not read most of the §CP
approvals he grants; he approves them on trust in the pipeline. A rubber-stamped gate provides no
protection while imposing full approval latency, **and it manufactures a false assurance that a
human vetted the change**. The intent is for the pipeline to self-heal via CI reds where CI can
carry it, and to reserve the human gate for where an unreviewed merge could actually weaken a guard.

**The stakes are higher than "one less review flavor," and this must not be soft-pedalled.** Branch
protection was read first-hand for this ADR — ruleset `17377992` ("main protection", `active`):

```
required_approving_review_count: 0
require_code_owner_review:       true
dismiss_stale_reviews_on_push:   true
```

With `required_approving_review_count: 0`, CODEOWNERS is the *only* source of a required human
approval. Removing a path from CODEOWNERS therefore removes **all** required human review of it, not
merely the §CP flavor. There is no residual review floor. Everything leaving §CP here is
CI-enforced, full stop.

## The two ADRs in play

**ADR [0187](0187-crew-mcp-is-not-control-plane.md) — the authority.** It already set the test:
*"a path is §CP if merging it unreviewed could weaken the pipeline's enforcement of its own rules …
The test is **enforcement surface**, not **proximity**,"* with the burden of proof *"Adding a package
to §CP requires showing an unreviewed merge of it could weaken a gate."* This ADR applies that test
**per path inside a package** rather than to the package as a unit.

**ADR [0100](0100-control-plane-covers-enforcement-guard-packages.md) — amended, in two distinct
ways.** This is not incidental bookkeeping; 0100 as written contradicts this change:

1. Its 2026-06-20 amendment **explicitly considered and rejected** this sub-path split: *"The whole
   package matches, not a `src/guards/` sub-prefix … A narrower prefix would leave that shared
   dispatch non-§CP … the broad `^packages/pipeline-cli/` match is the correct coverage."* That
   reasoning — the shared dispatch lives at the package root — is **correct and is honored here**,
   by the `src/[^/]+$` root branch. What is amended is the conclusion that honoring it requires
   swallowing the whole package.
2. Its **primary decision** named specific guards §CP **by name** — `leak-guard`, `spawn-guard`,
   `structured-output-guard`, `worktree-guard`, `read-guard` — on the grounds that *"a bad (or
   adversarial) edit that flips one of these fail-open is the 'a guard auto-merges a weakening of
   itself' case the control-plane boundary exists to prevent."* Those packages were folded into
   `packages/pipeline-cli/src/tools/` by ADR [0103](0103-consolidate-pipeline-cli-package.md). Under
   this core **they all leave §CP.** This ADR removes coverage 0100 granted explicitly. It is a
   deliberate trade under 0187's test — a guard that reds in CI on every PR is CI-enforced, and the
   founder's ruling is that CI enforcement, not a rubber-stamped approval, is the right control for
   them.

## Decision

The blanket `^packages/pipeline-cli/` branch is replaced by **three** anchored branches:

```
^packages/pipeline-cli/src/[^/]+$
^packages/pipeline-cli/src/tools/(ci-required|codeowners-cp|control-plane-paths|cp-cardinality|cp-classify|review-head|trivial-diff|verdict)/
^packages/pipeline-cli/src/tools/tracker/gh-io\.ts$
```

In the founder's enumeration the core is **thirteen paths**: the four shared-dispatch root modules
(`registry.ts`, `router.ts`, `bin.ts`, `gate-fail.ts` — carried here by the *broader* non-recursive
`src/[^/]+$` branch, which covers them and every other root module), the eight enforcement tool
**directories**, and `tracker/gh-io.ts`. The thirteenth is the only entry that gates a **single
file inside a directory that is otherwise not core**, which is why it needs its own `$`-anchored
branch and its own literal CODEOWNERS row (§3).

### 1. The `src/` root, non-recursive — the shared dispatch and plumbing

`registry.ts`'s `registeredTools[]` can disable any guard without touching that guard's own
directory; `router.ts`/`bin.ts` are the dispatch; `gate-fail.ts` is how a gate reds;
`read-stdin.ts`/`read-stdin-core.ts` are the fail-closed stdin read (#3924) that feeds
`cp-cardinality decide`; `run.ts`, `tool-registration.ts`, `module-load-guard.ts`, `annotate.ts`,
`find-root-dir.ts`, `version.ts` are process plumbing every gate runs through.

It is expressed as a **non-recursive pattern, not a file list**, deliberately. The list originally
proposed was four files (`registry`/`router`/`bin`/`gate-fail`) — it already lagged reality by seven
modules the day it was written. A pattern is rot-proof by construction: a root module added tomorrow
is §CP without anyone remembering to add it.

`codeowners-cp`'s `expandBranch` translates the `[^/]+` within-segment class to a gitignore `*`, so
the branch resolves to the §CP path `packages/pipeline-cli/src/*` and a
`/packages/pipeline-cli/src/*` CODEOWNERS row covers it exactly. (`*` is within-segment — the
`skills/**/*.sh` row above it needs `**` precisely because `*` does not cross `/`.)

### 2. The eight enforcement-surface tools

| Tool | Why an unreviewed edit could weaken a gate |
|---|---|
| `ci-required` | **Is** one of the branch-protection-required status checks (`ci.yml:1072` runs its `bin.ts`). |
| `verdict` | Decides whether a required namespace carries a current-head PASS (ADR 0058) — the enqueue gate. |
| `cp-cardinality` | Decides whether a §CP approval discharged (ADR 0175). `ship-it/SKILL.md:533` invokes it as the **local on-disk binary** with no `origin/main` re-resolution, so a merged weakening takes effect on every subsequent run. Flipping its `n === 0` branch from `stop` to `discharge` silently discharges §CP forever. |
| `control-plane-paths` | Emits `CONTROL_PLANE_RE` — the boundary definition itself. |
| `cp-classify` | Renders the §CP **verdict**. The only site that can return `not-control-plane`; carries the four-state `control-plane`/`content-undetermined`/`not-control-plane`/`unknown` machine whose own docblock names collapsing `unknown` → `not-control-plane` as "the recurring fail-open defect" (#3715, #4108, #4171, #4191). Also owns `CP_CONTENT_PREFIX`, the scope of the ADR-0164 content clause. |
| `codeowners-cp` | The regex ↔ `.github/CODEOWNERS` drift gate. |
| `trivial-diff` | Routes a PR to the lighter `review-trivial` gate (ADR 0120); its bound 3 is literally "Not control-plane." Weakening a bound rides a substantive or guard-relaxing change onto the lighter gate (#3645). |
| `review-head` | Resolves and materializes the head every verdict binds to (ADR 0058). `verdict`'s SHA-binding is only as good as the head resolution feeding it. |

The last three (`cp-classify`, `trivial-diff`, `review-head`) were **not** in the originally
proposed nine-path list. They were added by founder ruling after measurement showed retaining them
**costs zero relief over the measured window** — the same ten PRs leave §CP either way. On a
security-boundary narrowing, a free widening that closes three independently-verified fail-open
vectors is the obvious trade.

### 3. One file: `src/tools/tracker/gh-io.ts`

`gh-io.ts` exports `authorizedAuthors` (`gh-io.ts:209`) — the **ADR 0055 write+ ACL**, the trust
root that decides whose `review-*` marker counts at all. `verdict/github.ts:214-215` feeds its
result straight into `resolveVerdict`. An unreviewed edit widening it to return every author would
let a **forged verdict from a non-collaborator count as a PASS**: the enqueue gate would still
behave exactly as written while authorizing anyone. Retaining `verdict` — the tool that consumes
the decision — while leaving the source of the decision ungated is an incoherent line, and it
clears ADR 0187's burden of proof on its own terms.

It is anchored at the **file**, not at `tools/tracker/`. The rest of that directory is claim and
coordination tooling (`tracker claim`, presence stamping) that gates nothing, and sweeping it into
§CP would re-import exactly the rubber-stamp cost this ADR removes. `codeowners-cp`'s
`expandBranch` normalizes a `$`-anchored, `\.`-escaped leaf to a `kind: "file"` path, so the branch
resolves to the §CP path `packages/pipeline-cli/src/tools/tracker/gh-io.ts` and is owned by a
literal CODEOWNERS row of the same name — placed **after** the owner-less
`/packages/pipeline-cli/src/tools/` row, so last-match-wins re-owns it.

`^packages/ci-required/` is a **separate, independent** branch and is byte-unchanged, as are its
CODEOWNERS row and everything else in the regex. (That package no longer exists — it was an
empty shell by the time of the #6346 sweep. The branch is recorded here as it stood.)

## Closure — what leaves, and why that is or is not argued safe

ADR 0187's burden of proof runs the other way for a *removal*, so the honest question is: **is there
a path leaving §CP through which a change could reach the enforcement surface?** Four findings, each
addressed by name rather than by "the guards are green."

**(a) Transitive imports of the retained core.** Computed mechanically, not asserted — see
`core-import-closure.unit.test.ts`.

> **The walk needs two non-obvious rules to mean anything.**
>
> **It must see DYNAMIC `import()`.** `registry.ts` wires all 72 tool `command.ts` modules lazily
> (`tool("verdict", () => import("./tools/verdict/command.ts"))`, #4008), and a static-only
> `(?:from|import)\s+"…"` matcher cannot match `import(` at all — it saw two edges there and the
> walk was blind to every dynamic import in the package. A core module that later adds
> `import("./tools/<non-core>/x.ts")` would then be a **silent escape** with the check still green.
> A closure walker blind to the mechanism the codebase uses to wire tools is not evidence, so the
> matcher covers static `from`/`import`, dynamic `import(`/`require(`, and both quote styles, with
> extension and `index.ts` resolution and a **fail-loud** throw on an unresolvable specifier.
>
> **`registry.ts`'s registration fan-out is cut as an EDGE, not as a node.** Following it reaches
> 250 modules (211 escapes) and the check degenerates to "everything is core" — vacuously true,
> proving nothing. The fan-out is a *listing* edge, not a behavioral one: a gate does not run
> through its siblings' commands. Cutting only that one edge — while still following every other
> edge out of `registry.ts` — is what keeps the walk tractable without over-pruning; the
> node-scoped and edge-scoped walks give the same answer, which is how we know it does not
> over-prune. Any future closure check must cut it the same way.

With the `src/` root retained, the escapes measured on the fan-out-pruned graph collapse from
eleven to four; **promoting `tracker/gh-io.ts` into the core takes it to three.** `gh-io.ts` has no
relative imports of its own (only `effect`), so retaining it pulled nothing new into the closure —
re-derived mechanically, not assumed. The remaining three are **retained as a recorded residue, not
argued unreachable**:

| Escaping module | Reached from | Honest reachability |
|---|---|---|
| `tools/guard-content-probe/guard-content-probe.ts` | `trivial-diff/trivial-diff.ts` (`probeGuardContent`), `trivial-diff/command.ts` (`parseGuardAdrRe`) | Implements the **ADR-0164 §CP-by-content predicate** — the second §CP boundary definition. Weakening it makes a guard-relaxing ADR read as non-§CP to `trivial-diff`, routing it to the lighter gate. Surfaced by the mechanical check, *not* by the hand analysis, which had it as a second-order surface. |
| `tools/leak-guard/leak-guard.ts` | `verdict/verdict-match.ts` (`findCommentLeaks`) | Feeds `emissionDefect`, the verdict-emission path-leak check (#2796/#2822). Weakening it admits a leaking verdict body; it does not flip a PASS/FAIL. Lower stakes, but ADR 0100 named `leak-guard` §CP by name. |
| `tools/leak-guard/path-matcher.ts` | `leak-guard.ts` | Same surface, one hop further. |

`tools/tracker/gh-io.ts` was the fourth and **sharpest** of the measured escapes — it was the one
that could flip a PASS/FAIL rather than merely degrade a report — which is why it is now in the
core (§3 above) instead of on this list. That promotion is the answer to the question this section
asks; the three left are the ones the founder ruled stay CI-enforced.

**These three are the boundary's known cost, recorded rather than papered over.** The allowlist in
the test exists so the set **cannot grow silently**: a new unclosed import from the core reds the
check and forces a fresh decision. `guard-content-probe` in particular remains a live candidate for
a follow-up widening; nothing here argues it is safe, only that the ruled boundary is where the
founder set it and the residue is now visible instead of implicit.

**(b) Shared root modules beyond the four originally listed** — `tool-registration.ts`, `run.ts`,
`index.ts`, `module-load-guard.ts`, `version.ts`, `read-stdin.ts`, `read-stdin-core.ts`,
`annotate.ts`, `find-root-dir.ts`. **Closed by retention**: the non-recursive `src/[^/]+$` branch
covers all of them, and every future root module, by construction.

**(c) `packages/pipeline-cli/package.json` and the build/test configs** (`tsconfig*.json`,
`vitest.config.ts`) leave §CP. They are **not** argued unreachable in principle — `package.json`
declares the binary `ci-required` and `cp-cardinality` are invoked as. They are left out because
they are covered by a different, non-discretionary control: `catalog-guard` fails closed on any
non-`catalog:` dependency version, CI builds and runs the guard suites through those configs on
every PR, and a config edit that breaks a gate's build reds `ci-required` directly rather than
silently passing. This is CI enforcement, consistent with the ruling's premise.

**(d) Second-order gate surfaces.** `checks`, `merge-intent`, `merge-queue-classify`,
`class-probe`, `redact-leaks` (invoked by `ship-it`'s merge path) and `path-filter-guard` /
`change-detect-guard` (which produce the `changes` outputs `ci-required` consumes) all leave §CP.
They are invoked as separate processes by skills and workflows, not imported by the core, and each
runs in CI on every PR. `guard-content-probe` was on this list and turned out to be a **hard import
edge** — it is handled in (a) above, and its promotion from "second-order" to "in the closure" is
the concrete reason a mechanical check beats prose here.

## Consequences

- **`codeowners-cp` cannot catch a stale narrowing.** It detects **under-protection** only — a §CP
  regex path with no covering CODEOWNERS row. It **never** flags a CODEOWNERS row *broader* than the
  regex. So leaving the old `/packages/pipeline-cli/` row in place would not have redded any gate;
  the lockstep narrowing is an **author obligation**, not a gate-enforced one. Pinned by a test.
- **CODEOWNERS carries a belt-and-braces owner-less row.** `/packages/pipeline-cli/src/tools/` with
  no owners (GitHub's documented `/apps/github` unset idiom) sits between the `src/*` row and the
  eight retained tool rows, so the ~60 non-gating tools are ungated even if `src/*` were ever read
  as crossing `/`; last-match-wins re-owns the eight below it.
- **The `#981` anti-self-authorization property is unchanged.** The live merge-deciding gates still
  re-resolve `CONTROL_PLANE_RE` from `gh-issue-intake-formats.md` on `origin/main`, so this
  boundary-narrowing PR is classified against **main's** boundary — the pre-narrowing one — and
  banks for a human §CP approval. The narrowing cannot authorize itself.
- **The `#2761` single-source discipline is unchanged.** The const remains the one source; the
  formats-doc line and CODEOWNERS are drift-guarded against it by `codeowners-cp` and
  `validate-gate-path-drift.sh`, and every in-repo fixture imports the const rather than
  re-literaling it (the #2673 stale-fixture class).
- **Recorded follow-on, out of scope here (#4195 or its own issue):** extend the `origin/main`
  re-resolution idiom (#981, `control-plane-re.ts` lines ~42-46) to `cp-cardinality` and
  `ci-required`, so a weakened local copy cannot take effect. Once that exists, even those two
  could leave §CP.
