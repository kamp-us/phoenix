---
id: 0064
title: "Distribute epic-ledger by automated npm publish — rename to public `@kampus/epic-ledger`, publish from a `.github/workflows/` release pipeline on an `epic-ledger-v*` Release tag via OIDC Trusted Publishing (no stored token; npm CLI ≥ 11.5.1, `id-token: write`, provenance), publishing only `packages/epic-ledger`; `review-plan` resolves in-repo first and falls back to the published package via `pnpm dlx`; published version tracks source. Supersedes 0062 §3's deferral; the workflow file is control-plane (ADR 0053) so #366's PR is human-merged. Human prereqs: create the public `@kampus` npm org + register the repo/workflow as a Trusted Publisher for the package"
status: accepted
date: 2026-06-15
tags: [plugin, pipeline, packaging, epic-ledger, npm, ci, release]
---

# 0064 — Distribute epic-ledger by automated npm publish

> **Amendment (2026-06-16, ADR [0076](0076-decisions-index-npm-publish-automated-release.md) is now the canonical pattern).**
> This ADR's §1 originally pinned the `catalog:` deps (`effect`, `@effect/platform-node`)
> to concrete versions in `package.json` and published via `npm publish` (with an
> `npm install -g npm@latest` step). ADR [0076](0076-decisions-index-npm-publish-automated-release.md)
> corrected that pattern for decisions-index: `pnpm publish` resolves `catalog:`/`workspace:`
> specifiers into the tarball at pack time, so the source `package.json` keeps the pnpm
> catalog as the single source of truth — no dep pinning, no npm-upgrade step. **epic-ledger
> was retrofitted to match** (#456): its runtime deps are back on `catalog:` and its workflow
> publishes via `pnpm publish --access public`. Treat ADR 0076 as the canonical publish
> pattern; the dep-pinning prescription in §1/§2 below is superseded.

## Context

`review-plan`'s deterministic plan-gate is `@phoenix/epic-ledger`
(`packages/epic-ledger`) — an Effect CLI (`validateLedger` / `isPickable` /
`ledgerSignature`, bin run with `node packages/epic-ledger/src/bin.ts`). Today the
package is `private: true`, `version: 0.0.0`, `exports: "./src/index.ts"` (it runs
`.ts` directly), and its `effect` + `@effect/platform-node` deps sit on the workspace
`catalog:`. It exists only inside the phoenix checkout, so `review-plan` cannot run its
gate in a foreign repo — the one skill of the eleven-skill pipeline plugin that is not
repo-agnostic.

ADR [0062](0062-repo-as-config-plugin.md) §3 weighed three distribution mechanisms only
*directionally* — bundle the package into the markdown-skills plugin, publish it to npm
and invoke via `pnpm dlx`, or exclude `review-plan` from the portable set — and
**deferred** the choice: v1 shipped `review-plan` phoenix-pinned, degrading elsewhere
with a clear message, and named npm-publish "real work, its own epic" (§3, §6). Epic
[#362](https://github.com/kamp-us/phoenix/issues/362) is that follow-up epic, and issue
[#365](https://github.com/kamp-us/phoenix/issues/365) is the `type:decision` child that
must settle the mechanism before any cutover code (#366 producer, #367 consumer, #368
foreign validation) is written.

Supersedes [0062](0062-repo-as-config-plugin.md) §3 (the deferral) and updates
[0062](0062-repo-as-config-plugin.md) §6 (which named this the deferred follow-up). The
portability *target* — repo-agnostic — is not relitigated; 0062 already decided it. This
ADR decides *how* the package travels.

## Decision

### 1. Mechanism — publish epic-ledger to npm; `review-plan` resolves in-repo first, falls back to the published package

`epic-ledger` is **published to npm** as a public package. A foreign `review-plan`
invokes the published CLI; phoenix-local `review-plan` keeps using the in-repo
`packages/epic-ledger`. The gate-dependency resolution **prefers the in-repo package
when present and falls back to the published package** — concretely, `review-plan`
checks for `packages/epic-ledger/src/bin.ts` in the working tree and runs `node` against
it when it exists, otherwise invokes the published CLI via
`pnpm dlx <pkg>@<version> <epic>`. (#367 implements this resolution; this ADR fixes its
contract.)

Rationale: bundling drags an Effect dependency tree into a markdown-skills plugin (wrong
shape, heavy, and it would silently drift from source); a dependency-free rewrite trades
a maintained, tested validator for a hand-rolled re-implementation plus a perpetual
parity-test burden. Publishing keeps **one** source of truth — the same package phoenix
runs locally is the one foreign repos pull — and the in-repo-first resolution means
phoenix's daily pipeline never depends on the published artifact (no dogfood regression,
no network on the local gate path).

**Package name / scope.** The package is published under a **public** scope.
`@phoenix/epic-ledger` is *not* publishable as-is: it is `private: true` and `@phoenix`
is an internal workspace scope, not a registered public npm org. The publish therefore
**requires renaming to a public scope** — the recommended name is
**`@kampus/epic-ledger`** (the org's public identity; consistent with the `@kampus/*`
lineage). #366 flips `private` off, sets the public name, and pins the `catalog:` deps
(`effect`, `@effect/platform-node`) to concrete versions so a published `package.json`
resolves outside the workspace.

> **Human prerequisite (an agent cannot do this):** the `@kampus` npm org/scope must
> **exist and be owned by the maintainers**, with publish rights granted to the
> automation. Creating the npm org and registering the scope is a one-time human action;
> no pipeline step can self-provision it. If the org name changes, the published name in
> #366's `package.json` and the `pnpm dlx` invocation in #367 must change with it.

### 2. Fully-automated release pipeline

Distribution is a **fully-automated CI/CD release**, never a manual `npm publish` from a
laptop. A GitHub Actions workflow under `.github/workflows/` publishes
`packages/epic-ledger` to npm on a release trigger.

- **Trigger:** a published **GitHub Release** whose tag matches `epic-ledger-v*` (e.g.
  `epic-ledger-v0.1.0`). A package-scoped tag prefix keeps this workflow from firing on
  unrelated tags as the repo grows other publishable packages. Equivalent:
  `on: push: tags: ['epic-ledger-v*']`. (A changesets-style flow is an acceptable
  alternative if the repo later adopts changesets repo-wide; the release-tag trigger is
  the chosen default because it needs no extra tooling and binds the published version to
  a reviewable, human-cut release.)
- **Version source:** `packages/epic-ledger/package.json`'s `version` field is
  authoritative. The workflow publishes exactly that version; the release tag must match
  it (a guard step fails the run if the tag's version and the `package.json` version
  disagree, so a mistagged release never publishes a wrong version).
- **Scope of the publish:** the workflow publishes **only** `packages/epic-ledger`
  (`pnpm --filter @kampus/epic-ledger publish`, run from the package dir) — never the
  whole workspace, never any other package.
- **npm auth — OIDC Trusted Publishing (no stored token).** The publish workflow
  authenticates to npm via **OIDC**: it requests a short-lived credential per run
  (GitHub Actions `permissions: id-token: write`), so there is **no `NPM_TOKEN` secret
  stored in the repo** — nothing to rotate, no standing credential. Trusted Publishing
  requires **npm CLI ≥ 11.5.1**, and **provenance is generated automatically** under
  trusted publishing (the published artifact carries a verifiable link back to the
  building workflow and commit with no `--provenance` flag — the flag is no longer
  needed, see https://docs.npmjs.com/trusted-publishers/). A classic
  Automation/granular-access token was considered and rejected: it is a long-lived
  standing secret that must be stored and rotated, whereas OIDC mints an ephemeral
  credential scoped to the single run.

> **OIDC-only; staged publishing explicitly rejected.** npm's **staged publishing**
> (GA 2026-05 — `npm stage publish` followed by a maintainer 2FA approval before the
> version goes live; https://docs.npmjs.com/staged-publishing) was considered and
> **rejected**: it inserts a *mandatory human approval per release*, which directly
> conflicts with this epic's **full-automation** requirement (§2 — "never a manual
> `npm publish`", "zero-touch after setup"). **OIDC trusted publishing** (tokenless,
> automatic provenance on a public repo; https://docs.npmjs.com/trusted-publishers) is
> the chosen mechanism. The trade accepted is **no pre-publish human gate** — mitigated
> because the code has already passed the review→ship pipeline before any release tag is
> cut, the artifact carries automatic provenance, and the version-match guard step
> refuses a mistagged release.

> **Bootstrap sequence (the "package must exist first" gotcha).** Both trusted
> publishing *and* staged publishing require the package to **already exist on the
> registry** before they apply. The **first** publish of `@kampus/epic-ledger` is
> therefore a one-time **manual `npm publish` (with 2FA)** to create the package; the
> Trusted Publisher is configured **after** that first publish (per the §2 human
> prerequisites), and **every release thereafter** is automated via OIDC on an
> `epic-ledger-v<version>` tag. Version detail: the manual bootstrap publishes the
> **initial** version (e.g. `0.1.0`), and the **first OIDC-automated release is the next
> bump** (e.g. `0.1.1`) — publishing the same version twice would be rejected as a
> duplicate.

> **Human prerequisites (an agent cannot do these):**
> 1. **Create the public `@kampus` npm org/scope** (per §1) so the package has a public
>    home and the scope is registered on npmjs.com.
> 2. **Register the GitHub repo + the publish workflow as a Trusted Publisher** for the
>    `@kampus/epic-ledger` package on npmjs.com (package settings → Trusted Publishing).
>    This is per-package config and can only be done once the package/scope exists, so it
>    follows the first publish/scope creation. An agent cannot configure npm account
>    settings; a human sets this once. Without it the OIDC publish step fails closed.

### 3. Version-sync between the in-repo package and the published package

Because §1 resolves in-repo-first, the **published version must track the in-repo
package** or the two gate implementations drift — a foreign repo could run an older
published validator than phoenix runs locally, producing a different PASS/FAIL verdict
on the same ledger. The forcing rule: a change to `packages/epic-ledger`'s gate logic
**bumps `package.json`'s `version` and cuts a matching `epic-ledger-v*` release** in the
same change, so the latest published version always reflects the current in-repo source.
(#366 owns making this routine; the parity AC — "the same epic yields the same verdict
and the same defect set through the published artifact as through the in-repo CLI" — is
the observable check.)

## Consequences

- **The publish workflow is control-plane.** The `.github/workflows/` file lands under
  `.github/**` → **CONTROL-PLANE per ADR [0053](0053-control-plane-boundary.md)**. #366's
  implementation PR (which adds the workflow) is therefore **never auto-merged by
  `ship-it`** — a human merges it by hand, and `review-doc`/`review-code` are advisory on
  it. The package's own `package.json`/source changes (`packages/**`) stay non-blocking
  and auto-merge once gated; only the workflow file forces the human merge.
- **Supersedes ADR 0062 §3.** The "stay in-repo for v1 / `review-plan` phoenix-pinned /
  degrade-with-a-message" deferral is replaced: `review-plan` becomes genuinely portable
  via the published package, and the §3 degradation guard (#349) is removed by #367. ADR
  0062's "10/11 skills repo-agnostic" framing is now "11/11" once the epic lands (#368
  updates that framing).
- **One-time human cost, then zero-touch.** The human prerequisites are: create the
  public `@kampus` org, do the **one-time manual `npm publish` (with 2FA)** that brings
  the package into existence on the registry (trusted/staged publishing both require it
  to exist first), then register the repo/workflow as a Trusted Publisher for the
  package. After that, every release is a tag/Release away — no manual `npm publish`, no
  laptop credentials, no standing token to store or rotate. The first OIDC-automated
  release is the next version bump after the bootstrap (e.g. bootstrap `0.1.0` → first
  automated `0.1.1`) so it never re-publishes a version that already exists. The cost
  moves from per-release toil to a single setup.
- **OIDC over staged publishing — no human approval gate.** Choosing OIDC trusted
  publishing over npm staged publishing means there is **no mandatory per-release human
  approval** between cutting the tag and the version going live. This is deliberate (the
  epic requires full automation); the safety it trades away is recovered upstream by the
  review→ship pipeline gating the code before the release tag, plus automatic provenance
  and the version-match guard.
- **New maintenance obligation: version discipline.** §3 makes "bump-and-tag on every
  gate-logic change" a standing rule; skipping it silently desyncs foreign-repo gating
  from phoenix-local gating. The parity AC and the version-match guard step are the
  backstops, but the discipline is the primary defense.
- **Renaming `@phoenix/epic-ledger` → `@kampus/epic-ledger`** touches every in-repo
  importer of the package and the `node`/`pnpm dlx` invocation in `review-plan`. #366
  carries the rename; #367 carries the invocation. Until the rename lands, nothing
  publishes.
