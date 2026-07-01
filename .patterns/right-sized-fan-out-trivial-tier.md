# The right-sized fan-out — the trivial-diff tier

How the pipeline routes a **trivially-classified** PR through a lighter-but-still-fail-closed
review gate instead of the full `review-code` / `review-doc` / `review-skill` fan-out. This is
the *shape of the shipped mechanism*; the *why* + the bounds are ADR
[0120](../.decisions/0120-stage-right-sizing-trivial-diff-lighter-gate.md), and the adoption
gate is ADR [0112](../.decisions/0112-token-measurement-no-quality-compromise-methodology.md).
This doc points at those, it does not re-derive them.

The tier is **off by default and no token win is claimed here** — the branch is wired but a
pure no-op until child [#1560](https://github.com/kamp-us/phoenix/issues/1560)'s two-axis
measurement authorizes the flip (ADR 0112). Read this to understand the composed path; read
0120 for the decision and 0112 for the measurement discipline.

## The problem it right-sizes

The executor drives **one full fan-out per PR** (`write-code` → a `review-*` gate → `ship-it`)
at a roughly constant cost regardless of diff size — a one-line doc fix pays the same gate
overhead as a 200-line refactor (the #1486 worked example: #1399, a single-line `CLAUDE.md`
fix, still paid the full fan-out). On a backlog drain where most PRs are small, that fixed
overhead dominates spend on the lowest-value work. The tier captures the saving on the small-PR
case **at the gate's prompt cost, never at its authority to FAIL** — it is *right-sizing* the
gate, emphatically **not** skipping it (ADR 0120 option (b), rejected).

## The three pieces and how they compose

The tier is three shipped pieces that compose into one default-deny path. None of them adopts
the lever — they make the branch *exist and be measurable* while it stays off.

### 1. The classifier — a deterministic, fail-closed trivial-diff predicate (#1557)

`pipeline-cli trivial-diff classify` (`packages/pipeline-cli/src/tools/trivial-diff/`) reads a
unified diff and prints one verdict word to stdout — `trivial` or `non-trivial` — with the
deciding reason on stderr. It is a pure IO-free core (`trivial-diff.ts`, unit-tested) behind a
thin bin (`command.ts`) that does the IO. A diff is `trivial` **only if it clears every bound**
(a hard AND, in the spirit of ADR [0070](../.decisions/0070-investigation-trivial-fix-collapse.md)):

- **Small + single-concern** — exactly one changed file that is doc/comment-only (a doc
  extension or a path under `.decisions/` / `.patterns/` / `.glossary/` / `docs/`, trivial at
  any size) **or** a single non-doc file under the line bound `N` (added + removed).
- **No new surface / code-path change** — no surface-bearing path (dependency manifest,
  lockfile, migration, `.sql`, stack/build config) and no new module edge
  (`export` / `import` / `require(`) in the added lines.
- **Not control-plane** — no changed path matches the **live** `CONTROL_PLANE_RE`, re-resolved
  from `origin/main` at run time by the bin (single-sourced via `codeowners-cp`'s
  `extractControlPlaneRe`), never a stale snapshot (the #981 mis-classification class).

The predicate is **fail-closed by construction** (ADR 0120 §3): a diff is `trivial` only on a
positive, all-bounds-clear result. A failed bound, an unparseable diff, or an
unreadable/uncompilable live boundary all resolve to `non-trivial` — there is no third
"unknown" state a caller could read as trivial. The worst case of a miss is paying the full
(correct) fan-out, never under-gating.

### 2. The lighter gate — `review-trivial`, a reduced gate, not a skipped gate (#1558)

`claude-plugins/kampus-pipeline/skills/review-trivial/SKILL.md` is a **reduced-prompt** verify
path a trivially-classified diff can take instead of the full fan-out. It is still an
**independent, fail-closed gate** run by a reviewer (never the author — the split-role firewall
of ADR [0052](../.decisions/0052-review-code-config-isolation.md) is unchanged):

- **Step 0 re-affirms triviality independently and fail-closed** — it re-resolves the live
  `CONTROL_PLANE_RE` under its own eyes; a control-plane path, an unreadable boundary, a
  multi-concern diff, or a new surface all make it **DECLINE** (a plain not-trivial note, no
  verdict marker), which the executor routes to the full path that round.
- **Step 2 is the reduced fan-out** — a tight, conjunctive scoped checklist over the small diff
  for exactly the failure classes a one-liner can carry: the right change vs the AC, no leaked
  secret, no leaked machine-local / home / absolute / sibling-repo path. Only the *prompt cost*
  is reduced, never the authority to FAIL.
- **Step 3 emits in the existing namespace** — a SHA-bound (ADR
  [0058](../.decisions/0058-sha-bound-verdict-contract.md)) PASS/FAIL verdict in the **existing**
  `review-code` / `review-doc` / `review-skill` namespace for the diff's artifact class, never a
  new marker, so `ship-it` consumes it with no change.

### 3. The wiring — the executor's default-deny tier branch + fail-closed fallback (#1559)

`.claude/workflows/drive-issue.js` inserts a **Classify** phase before the **Review** phase:
when the tier is enabled it classifies the PR diff (consuming the classifier's stdout-verdict
CLI contract only, never its internals) and routes the Review phase by the default-deny rule.
The routing decision is the unit-tested canonical predicate `selectReviewTier` in
`packages/pipeline-cli/src/tools/trivial-diff/route.ts`; the workflow **mirrors it inline**
because a workflow script (top-level `return` + injected globals) is not importable as a module.

```
selectReviewTier = tierEnabled AND classifierOk AND verdict === "trivial"  ?  "lighter"  :  "full"
```

**Default-deny (ADR 0120 §3):** the lighter path is selected **only** on the full positive
conjunction. Every other state — the tier off (its default), a classifier error/unparseable
output, a `non-trivial` verdict, an unrecognized verdict word, or a `review-trivial` DECLINE —
falls back to the **full** fan-out. A misclassification can therefore only ever over-pay the
full (correct) cost, never under-gate a non-trivial change under the lighter gate.

## Adoption is gated behind the #1560 measurement (ADR 0112) — do not read this as "on"

Wiring the branch is **not** flipping the lever. The tier is **off by default**; the
`selectReviewTier` conjunction's `tierEnabled` term is set by `KAMPUS_TRIVIAL_TIER=on` (or
`args.trivialTier=true`) and is unset in normal operation, so **off ⇒ every PR takes the full
fan-out exactly as before, a pure no-op** with zero added cost (the Classify phase runs only
when the tier is enabled). Adoption is gated, per ADR 0112, on child
[#1560](https://github.com/kamp-us/phoenix/issues/1560)'s measurement holding **both axes
simultaneously**:

- **Token axis** — a real, measured token-per-PR reduction for the trivial path vs the full
  fan-out, against the recorded baseline
  ([token-economics-measurement.md](./token-economics-measurement.md)).
- **Quality axis (the veto)** — measured gate-accuracy on the frozen set showing the lighter
  gate still catches a bad trivial change (a wrong one-liner, a leaked secret/path). A quality
  regression **vetoes the lever regardless of the token win**.

So describe the tier as *shipped-but-dormant, adoption gated behind #1560*, never as adopted.

## Why it stays fail-closed end to end

Three independent fail-closed points compose so the worst case is always *over-paying tokens*,
never *under-gating quality*: the classifier defaults to `non-trivial` on any doubt (piece 1),
the executor's routing defaults to the full path on anything but the positive conjunction
(piece 3), and the lighter gate re-affirms triviality itself and DECLINEs — re-routing to the
full path — if the diff is not actually trivial (piece 2). The split-role firewall (ADR 0052)
and the SHA-bound verdict contract (ADR 0058) are untouched.

## See also

- ADR [0120](../.decisions/0120-stage-right-sizing-trivial-diff-lighter-gate.md) — the decision,
  the bounds, and the four parts this doc describes.
- ADR [0112](../.decisions/0112-token-measurement-no-quality-compromise-methodology.md) — the
  no-quality-compromise measurement methodology that gates adoption.
- ADR [0070](../.decisions/0070-investigation-trivial-fix-collapse.md) — the precedent bounded
  cheaper path (a hard AND of checks that skips ceremony, not the gate) this composes with.
- The control-plane boundary — ADR [0053](../.decisions/0053-control-plane-boundary.md) /
  [0065](../.decisions/0065-gate-critical-skills-are-blocking.md) /
  [0100](../.decisions/0100-control-plane-covers-enforcement-guard-packages.md); the live
  `CONTROL_PLANE_RE` is defined once in
  [`skills/gh-issue-intake-formats.md`](../claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md) §CP.
- [product-development-cycle.md](../product-development-cycle.md) — where the tier sits in the
  deploy→release cycle's review step.
