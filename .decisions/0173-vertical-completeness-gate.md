---
id: 0173
title: Vertical-completeness gate — a flag can't graduate while its UI slice is unbuilt (one `reachability-guard`, keyed off by `plan-epic` + `/release`)
status: accepted
date: 2026-07-11
tags: [pipeline, release, flags]
---

# 0173 — Vertical-completeness gate

## Context

kamp.us ships **verticals** (storage → service → fate → UI → tests), but "we ship
verticals" is an *unenforced convention*. A user-facing feature can be decomposed, built,
merged, and flag-graduated to 100% while its **user-facing slice was never built** — and
nothing in `plan-epic`, `triage`, `review-code`, `ship-it`, or `/release` ties "this flag
reached 100%" to "a consuming UI exists and is reachable." The feature then presents as
DONE/RELEASED while delivering zero user value, caught only when a human happens to notice.

This is not one bad feature; it is a systemic blind spot with three confirmed instances (epic
[#1943](https://github.com/kamp-us/phoenix/issues/1943)):

- **reactions** — the backend vertical shipped in full (react/change/retract mutations, the
  `reactions` view field on pano post/comment + sözlük definition, aggregate reads) and the
  `PHOENIX_REACTIONS` dark-ship flag reached 100% in production while **no `.tsx` in
  `apps/web/src` consumed it** — the flag key was referenced only by its own definition in
  `apps/web/src/flags/keys.ts`, the exact zero-UI graduation this gate exists to prevent. (This
  was the *motivating* instance, not a still-open one: the reactions UI slice —
  `apps/web/src/components/reaction/ReactionBarSlot.tsx`, PR #2055, landed 2026-07-05 — has since
  consumed the flag, so `phoenix-reactions` now **passes** the consuming-UI assertion. UI slice
  externally owned by #1867 under epic #1840.)
- **mecmua discovery** (#2512) — no nav entry / index page; reachable only by direct slug URL.
- **mecmua subscribe** (#2527) — subscribe/unsubscribe mutations exist, no UI to subscribe.

The last two sat inside a *single* epic — which is exactly why `plan-epic`'s existing
story-coverage invariant (every story has ≥1 child at plan time) did not catch them: it proves
*stories-have-children*, never *the UI slice actually shipped before graduation*.

The flag flip is the human release act (ADR
[0083](0083-agents-deploy-humans-release.md): agents deploy, humans release); `/release` is
the guarded ritual around it (its flip is Step 2, `cf-utils flag set … --execute`), and it
"explicitly ends: no gate, no merge, nothing further." That flip is the last gate before a
feature becomes visible, and it is unguarded against unreachability. This ADR is the **root
dependency** of epic #1943: it pins the enforcement mechanism the three build children
(#2529 the checker, #2530 the `plan-epic` edit, #2531 the `/release` edit) implement against,
before any of them is worked.

## Decision

Make an unreachable-feature graduation **unrepresentable**: a flag cannot reach 100% while its
vertical's user-facing slice is unbuilt. Three pinned commitments.

### 1. The enforcement seam — one shared `reachability-guard`, two consumers

The reachability check is owned by **a single deterministic `pipeline-cli` subcommand,
`reachability-guard`** (the pure-core + thin Effect-bin idiom of `fanout-guard` /
`readme-guard` / `epic-ledger`, `packages/pipeline-cli/src/tools/`). It is the **one shared
contract** both skills key off — not two independently-drifting notions of "reachable."

Given a Flagship flag key, `reachability-guard` asserts **both**:

- **(a) a consuming UI exists** — ≥1 `apps/web/src/**/*.tsx` references the flag-key constant
  exported from `apps/web/src/flags/keys.ts`, *beyond that constant's own definition*. This is
  the exact static scan the reactions reporter ran by hand (`PHOENIX_REACTIONS` failed it:
  consumed by zero components). The check resolves the constant name from the keys module, then
  greps the SPA source for a reference outside `keys.ts` itself.
- **(b) a registered journey e2e exists** — a playwright spec in `apps/web/tests/e2e/`
  (the suite of `apps/web/playwright.config.cjs`) is registered against the flag key.

It **fails closed** and **names precisely which assertion failed** (missing UI consumer /
missing journey e2e / unclassified flag), so a releaser or planner learns exactly what to
build. Per ADR [0092](0092-gates-fail-closed-on-zero-scope.md) it fails on zero scope (an
unknown/unclassified flag key is a failure, never a silent pass).

The two consumers key off this one contract:

- **`/release` (release-time refusal, #2531).** The gate slots **between Step 1 (pre-flight,
  which already resolves `$FLAG_KEY` + the linked issue) and Step 2 (the flip)** of
  `release/SKILL.md`. `/release` runs `reachability-guard <flag-key>` and **hard-refuses the
  flip on a non-zero exit** — the same fail-closed refusal shape as the skill's guard-0
  human-only refusal, not a soft warning it proceeds past. `/release` stays **HUMAN-ONLY**
  (ADR 0083); this makes the gate a check the human's `/release` run performs, not an
  autonomous one.
- **`plan-epic` (plan-time emission, #2530).** For a user-facing epic, `plan-epic` emits the
  user-facing reachability/journey slice as a **release-blocking child sibling** of the backend
  slices — a first-class blocker planned up front, not an optional tail — so the UI + journey
  work is the thing that makes `reachability-guard` pass at release time.

### 2. How reachability is asserted — static consumer scan + a `@journey:<flag-key>` tag

- **Consuming UI:** the static flag-key-consumer scan of assertion (a) above — resolved against
  the `apps/web/src/flags/keys.ts` constant and the `apps/web/src/**/*.tsx` SPA source.
- **Journey e2e:** registration is by an in-spec **`@journey:<flag-key>` tag** (playwright's
  title-tag convention — a `@journey:phoenix-reactions` token in the spec's `test`/`describe`
  title), **not** a separate flag-key→spec registry file. A tag co-locates the registration
  with the spec it names (nothing to keep in sync, nothing to orphan), and `reachability-guard`
  asserts a spec bearing the tag exists while the e2e job runs it. The checker asserts
  *registration*; it does not itself run playwright.

### 3. The exemption model — an opt-out-with-stated-reason for UI-less flags

A legitimately **UI-less flag** — an infra/containment flag with no user-facing surface *by
design*, e.g. `pano-feed-edge-cache` (ADR [0170](0170-workers-cache-via-alchemy-effect-pnpm-patch.md),
`PANO_FEED_EDGE_CACHE`), which gates edge-caching behavior a user never sees — must be able to
graduate without a UI consumer or a journey e2e. The gate would otherwise block correct infra
releases.

Exemption is an **explicit opt-out with a stated reason, declared at the flag-key definition
site** (`apps/web/src/flags/keys.ts`): the flag carries a machine-readable
`@reachability-exempt: <reason>` marker in its doc-comment (mirroring the cycle doc's flagging
opt-out). `reachability-guard` reads the marker and passes the flag *because a human wrote down
why it has no UI*. There is no silent skip and no blanket allowlist: an unmarked flag with no
consumer fails, an exempt flag names its reason. This is the make-or-break edge — the gate
refuses unreachable **user-facing** flags without blocking infra-containment flags.

### 4. Relationship to the concrete instances — upstream of, and independent of, each UI build

This gate is **upstream of and independent of** each UI build. It does **not** build the
reactions UI (#1867 under epic #1840) or the mecmua UIs (#2512, #2527); it makes their absence
**block graduation**. Those three UI builds proceed on their own tracks; the gate is the
process change that guarantees the *next* such feature cannot silently graduate without them.

The four downstream units of epic #1943 land on a strict spine: this ADR (root) → the
`reachability-guard` checker (#2529, T0/T1 unit-tested pure core, seeded so `PHOENIX_REACTIONS`
FAILs the consuming-UI check) → the two skill edits (#2530 `plan-epic`, #2531 `/release`),
which are **§CP** (gate-critical skills, ADR [0053](0053-control-plane-boundary.md)) and stop
at reviewed-ready for human merge at ship-it Step 0 (ADR [0048](0048-ship-it-merge-actor.md)).

## Consequences

- **A dark-ship flag can no longer graduate to 100% with no UI behind it.** "Released" recovers
  its meaning: at 100%, a user can always see and use the feature. The reactions/mecmua class of
  silent zero-UI graduation becomes impossible-by-construction on the release path.
- **New authoring obligations.** Every user-facing dark-ship flag now needs a consuming `.tsx`
  and a `@journey:<flag-key>`-tagged e2e before `/release` will flip it; `plan-epic` bakes that
  work in as a release-blocking sibling so it is planned, not discovered at the lever.
- **Every UI-less flag must declare `@reachability-exempt: <reason>`** at its `keys.ts`
  definition or `/release` will refuse it. This is a small, deliberate authoring cost that
  converts "no UI" from an invisible default into a stated, reviewable decision.
- **One contract, no drift.** Because `plan-epic` and `/release` both call the same
  `reachability-guard`, plan-time and release-time can never disagree about what "reachable"
  means — the recurring failure mode when two skills each hard-code their own notion.
- **Cost / limits.** `reachability-guard` proves a consuming reference and a *registered* e2e
  exist — presence, not correctness: a stub consumer or an empty-bodied journey spec passes the
  static check (the journey job's actual run, and `review-code`, remain the correctness gate).
  The gate raises the floor from "no UI at all" to "a wired-in UI + a named journey," not to
  "a verified-good UX." The `/release` human-only boundary (ADR 0083) is unchanged — the gate is
  a check the human's run performs, never a new autonomous actor.

Vocabulary: this ADR is the canonical coining site for **vertical-completeness gate**,
**reachability check / consuming-UI assertion**, and **journey e2e**. Those rows route to
`.glossary/LANGUAGE.md` (the architecture vocabulary) via a follow-up `/glossary` invocation
(per epic #1943's vocabulary-impact plan), so the downstream `write-code` agents inherit the
canonical names rather than re-coining synonyms.
