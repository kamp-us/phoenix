---
name: rite-audit
description: >-
  Drive the Playwright MCP against a flag-on audit stage to walk the v1 earned-authorship rite (çaylak→yazar) as an agentic explorer and emit raw pass/fail findings per dimension. Trigger on "run the rite audit", "audit the authorship rite", "rite-audit", "walk the çaylak→yazar rite", "/rite-audit". This is the audit harness's explorer: it consumes the ephemeral stage lifecycle (@kampus/audit-stage, #1512) — its base URL + minted test-mod — provisioned by epic #1510, runs each registered dimension over that one stage, and produces the raw findings the verdict report (#1516) structures and archives. It never deploys, seeds, or destroys the stage (that is @kampus/audit-stage), and never runs against production.
---

# rite-audit

You are the **agentic explorer** of the earned-authorship rite. The product question this
harness answers is not "does each unit test pass" but "**can a real person walk the whole
çaylak→yazar rite end to end, on a real deployed stage, with no human in the loop?**" You
answer it by driving a browser through the rite the way a person would — register, write,
get vouched, watch your tier flip — and recording, transition by transition, whether each
step actually happened. A judgment audit, not a fixed spec suite (epic
[#1510](https://github.com/kamp-us/phoenix/issues/1510)).

You run **against an ephemeral audit stage, never production.** The `phoenix-authorship-loop`
flag is an all-or-nothing kill-switch with no targeting — flipping it on in production releases
v1 to the public — so the rite is only walkable where #1511 forces the flag on: the dedicated
`audit` deploy class. The stage is provisioned, seeded, and torn down by
[`@kampus/audit-stage`](https://github.com/kamp-us/phoenix/blob/main/packages/audit-stage/README.md)
(#1512); **you are the run hook it invokes**, not the lifecycle. You receive the live stage's
coordinates and drive it; you never deploy, seed, mint, or destroy anything.

## The split of responsibilities — what you own vs what you consume

- **`@kampus/audit-stage` (#1512) owns the stage.** It deploys the `audit` stage (flag forced
  on by #1511), preview-seeds it, mints a login-able test-mod, calls **you** through its
  `runHook` seam, then tears the stage down on every exit path. You never touch deploy/seed/destroy.
- **You (this skill) own the walk.** Given the stage's coordinates and the test-mod, you drive
  the Playwright MCP through each registered **dimension** and emit that dimension's raw findings.
- **The verdict report (#1516) owns the archive.** You emit *raw* findings (the union of every
  dimension's `Finding`s); #1516 structures them into the dated, run-over-run-comparable verdict
  and archives it. Do not format an archive here — emit findings, hand off.

## Consume the run context — never hardcode a URL or credentials

Everything stage-specific arrives as the **run context**, the
[`AuditRunInput`](https://github.com/kamp-us/phoenix/blob/main/packages/audit-stage/src/lifecycle.ts)
the lifecycle hands its `runHook` (the seam you fill). It is the single source of the stage's
identity:

```ts
interface AuditRunInput {
  readonly stage: string;      // the audit stage name
  readonly baseUrl: string;    // the deployed stage's worker base URL — drive THIS, never a literal
  readonly target: D1Target;   // the stage D1 (accountId, databaseId) — for direct-D1 assertions
  readonly testMod: TestMod;   // the minted moderator+yazar identity
}
interface TestMod {
  readonly userId: string;     // the better-auth user.id of the seeded mod
  readonly email: string;      // login credential for the divan vouch/promote
  readonly password: string;
}
```

**Hardcoding a stage URL or any credential is a defect, not a shortcut.** The stage is
ephemeral — its URL changes every run, and the test-mod is freshly minted per run — so a
literal would be stale on the next run and would point a flag-on audit at the wrong target.
Read `baseUrl` and `testMod` off the run context and pass them into every dimension. If you
are invoked without a run context (a bare manual run), **stop and report that the stage
lifecycle must provide it** — do not invent one.

The test-mod is the *only* pre-existing identity. The çaylak under test is **not** seeded:
each run **self-registers a fresh çaylak** through the UI (the rite's first transition), so
the audit exercises the real sign-up path and never depends on a leftover account.

## Playwright MCP wiring

Drive the stage through the Playwright MCP browser tools (navigate, click, type, read text,
snapshot/screenshot). The contract for the explorer:

- **Navigate by `baseUrl` + a route-map path**, never a literal origin: `${baseUrl}${path}`.
- **Anchor on stable `data-testid`s** where the surface exposes them (the route map lists the
  load-bearing ones). Prefer a testid over visible Turkish copy so a copy tweak never silently
  breaks the walk; fall back to the glossary-canonical Turkish label only where no testid exists.
- **One browser context per identity.** The çaylak and the test-mod are distinct sessions —
  drive them in separate contexts (or sign out fully between them) so a stale session never
  leaks one identity's authority into the other's assertions.
- **Observe before you assert.** Every check is `drive → observe → assert → record`: take the
  action, read the resulting DOM/text/screenshot, compare against the rubric's expectation,
  then emit exactly one `Finding`. Capture a screenshot as evidence at each asserted transition
  (the verdict report attaches them).
- **Force a browser media state via the `emulateMedia` seam.** When a check must *force* a media
  feature rather than read the stage default, drive the `browser_emulate_media`-style MCP tool
  over Playwright's page-level `page.emulateMedia({ reducedMotion, colorScheme, forcedColors })`
  (a CDP `Emulation.setEmulatedMedia` bridge). This single seam covers all three feature axes, so
  a dimension can force `prefers-reduced-motion: reduce`, `prefers-color-scheme: dark`, or
  `forced-colors: active` before it observes — it is general, not reduced-motion only.
  `browser_evaluate` can only *read* the current media state
  (`matchMedia('(prefers-reduced-motion: reduce)').matches`); reading the default is not a
  drive-test — force the feature ON through this seam first, then observe the app's response and
  restore the default (`{ reducedMotion: 'no-preference' }`) after. If the seam is absent from the
  exposed tool surface, that is a **BLOCKED** precondition for any check that depends on it (story
  11), never a silent pass.

## The route map — the rite surfaces

Grounded in [`apps/web/src/App.tsx`](https://github.com/kamp-us/phoenix/blob/main/apps/web/src/App.tsx).
Every dimension walks a subset of these; navigate each as `${baseUrl}<path>`.

| Path | Surface | Role in the rite | Key anchors |
| --- | --- | --- | --- |
| `/auth` | `AuthPage` | çaylak self-registration (the "kayıt ol" form) + test-mod login | form fields by `name`: `email`, `password`, `username`, `name` |
| `/sozluk` · `/sozluk/:slug` | `SozlukHome` · `SozlukTermPage` | a sandbox write target (a çaylak definition lands sandboxed) | term page definition list |
| `/pano/yeni` · `/pano` · `/pano/:id` | `PanoSubmitPage` · `PanoFeed` · `PanoPostDetail` | the other sandbox write target + the public feed (live visibility) | submit form; feed items |
| `/divan` | `DivanPage` | the reviewer workspace — **404 when the flag is off** (gates the whole rite) | `divan-caylak-<authorId>`, `vouch-button`, `promote-button`, `divan-upvote-<id>`, `incelemede-badge` |
| `/profile` | `ProfilePage` | the çaylak's own tier readout (the flip surface) | `caylak-status-block`, `caylak-status-in-review`, `caylak-status-vouch` |
| `/u/:username` | `UserProfilePage` | a third party's view of the author (cross-user visibility) | profile header standing label |
| `/search` | `SearchPage` | a cross-user discovery surface (sandbox-leak dimension) | results list |
| `/` | `LandingPage` | landing stats / featured corpus | landing stat blocks |

> `/divan` **self-gates on `phoenix-authorship-loop`** (404 when the flag is off — `App.tsx`).
> On the audit stage #1511 forces the flag on, so `/divan` resolves for an authorized
> (yazar/mod) viewer. If `/divan` 404s on the stage, the flag-force seam is broken — that is a
> **BLOCKED** precondition for the functional rite (which rolls up FAIL), not a silent skip.

## The dimension model — the fixed-rubric extension point

The audit is a set of independent **dimensions**, each a self-contained vertical (its surfaces +
its explorer steps + its pass/fail rubric) that runs over the *same* provisioned stage and emits
its own raw findings. The dimension is the unit of extension: later children add a dimension by
dropping one file, with no change to the harness.

**The full contract — what a dimension declares, the shared primitives it consumes, the
`Finding`/`DimensionResult` shape it emits, and the registration step — lives in
[`DIMENSIONS.md`](./DIMENSIONS.md). Read it before adding or running a dimension.** It is the
documented interface a11y (#1514) and sandbox-leak (#1515) plug into and that the verdict
report (#1516) aggregates; treat it as the contract, not a suggestion.

### Active dimensions

Each registered dimension is one file under [`dimensions/`](./dimensions/). Run every active
dimension over the one provisioned stage, in order, collecting each `DimensionResult`.

| `id` | File | Status |
| --- | --- | --- |
| `functional-rite` | [`dimensions/functional-rite.md`](./dimensions/functional-rite.md) | active (this child, #1513) |
| `accessibility` | [`dimensions/accessibility.md`](./dimensions/accessibility.md) | active (#1514) |
| `sandbox-leak` | [`dimensions/sandbox-leak.md`](./dimensions/sandbox-leak.md) | active (#1515) |

## The run procedure

1. **Receive the run context** (`AuditRunInput`) from the `@kampus/audit-stage` `runHook`.
   Confirm `baseUrl` and `testMod` are present; abort loudly if not (never fabricate them).
2. **Preflight the gate.** Navigate `${baseUrl}/divan` as the test-mod; if it 404s, the
   flag-force seam (#1511) is broken — record a BLOCKED precondition and stop the functional
   rite (it cannot run without the gate open).
3. **Run each active dimension** in order ([`DIMENSIONS.md`](./DIMENSIONS.md) §Running a
   dimension), driving the Playwright MCP per that dimension's file. Each emits a
   `DimensionResult` (PASS iff every `Finding` is PASS; any FAIL **or** BLOCKED ⇒ FAIL).
4. **Emit the raw findings bundle** — the union of every dimension's `Finding`s, with the
   per-dimension `DimensionResult` status. This is the explorer's output. **Hand it to the
   verdict report (#1516)** for structuring/archiving; do not format the dated archive here.

## Never silently pass — the load-bearing invariant (story 11)

A transition that **cannot be evaluated** — a surface that 404s when it should resolve, a step
whose precondition failed, a click that produced no observable change — is **never** recorded
as PASS and **never** dropped. It is recorded as a `Finding` with status FAIL (or BLOCKED, which
rolls up to FAIL at the dimension level). The whole point of the audit is to make a broken rite
*unmistakable*; an unevaluated check that quietly disappears would defeat it. When in doubt
between PASS and "couldn't tell", it is **not** PASS.

## Scope — what this skill does not do

- It does **not** deploy, seed, mint, or destroy the stage — that is `@kampus/audit-stage` (#1512).
- It does **not** run against production — only a flag-on `audit` stage (the flag is a public
  release switch; ADR 0083).
- It does **not** structure or archive the dated verdict — it emits raw findings; #1516 archives.
- It does **not** implement the a11y or sandbox-leak dimensions — those are #1514 / #1515, added
  per the [`DIMENSIONS.md`](./DIMENSIONS.md) contract.
