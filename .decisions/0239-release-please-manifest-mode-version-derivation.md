---
id: 0239
title: release-please in manifest mode derives versions by changed path; humans still cut the release
status: amended-in-part by [0292](0292-dispatched-publish-path-tag-bound.md)
date: 2026-08-02
tags: [release-engineering, packaging, npm, ci, pipeline]
---

# 0239 — release-please in manifest mode derives versions by changed path; humans still cut the release

**What this decides:** A bot works out what the next version number of each publishable package should be, by reading the conventional-commit messages of the commits that touched that package's files, and parks the answer in a pull request that sits there until a human merges it. Merging that PR is what tags a release; tagging is what fires the existing publish job. Nobody hand-picks a version number any more, and nothing reaches npm without a human having merged something.

## Context

The publish half of this repo's release path already exists and works. ADR
[0064](0064-epic-ledger-npm-publish-automated-release.md) stood up OIDC Trusted Publishing,
ADR [0076](0076-decisions-index-npm-publish-automated-release.md) corrected the publish verb
to `pnpm publish`, and ADR [0103](0103-consolidate-pipeline-cli-package.md) collapsed the
per-package workflows into the single `.github/workflows/publish.yml` that fires on a
human-cut GitHub Release. That path is not theoretical: `@kampus/pipeline-cli@0.2.1` and
`@kampus/fabrika-cli@0.1.0` are live on the registry today, alongside the
`@kampus/decisions-index`, `@kampus/epic-ledger` and `@kampus/cdk-constructs` packages from
the 0064/0076 era, and `@kampus/depo` is publishable at `0.1.0`. This is a multi-package
release surface that exists, not a design for one package.

What has never existed is the *version-derivation* half. Every version number so far was
picked by hand and typed into a `package.json`, and the release tag was typed to match it.
That is the gap #4791 opened: the repo has publishing, and no convention-driven versioning.

Two constraints are load-bearing here and are carried forward as binding constraints below.
They have **different provenance**, and the difference is stated rather than blurred: one is
inherited from an earlier ADR, the other is recorded by this ADR for the first time.

- **npm versions are immutable.** A published version can never be corrected in place, only
  superseded by a higher one. Any automation that can fire before a rename or a manifest fix
  has landed bakes the error into the registry permanently. **No ADR has ruled this before —
  this one does.** It is a registry fact rather than an inherited ruling, and the evidence it
  rests on is this repo's own near-miss: the `@kampus/fabrika-cli@0.1.0` bootstrap publish
  (2026-08-03) very nearly shipped a retired command name because the local checkout doing the
  publish was behind the merge that renamed it. Binding from here, and inherited by #4801 and
  #4803.
- **The publish verb is `pnpm publish`, never `npm publish`.** This one *is* inherited — from
  ADR [0076](0076-decisions-index-npm-publish-automated-release.md) §2, which is
  `superseded by [0103](0103-consolidate-pipeline-cli-package.md)` on the packaging axis but
  **not** on the verb: 0103 does not restate the verb ruling, so superseded-0076 remains its
  only written ADR home and is cited here as live on that point alone. Every dependency in this
  repo is sourced from the pnpm workspace `catalog:` (the CLAUDE.md convention, enforced by
  `catalog-guard`). npm cannot resolve a `catalog:` specifier and would ship the literal
  string `"catalog:"` as a dependency range, producing a tarball installable by nobody. pnpm
  resolves catalog and workspace specifiers into the tarball at pack time, which is what makes
  the catalog safe to keep as the single source of truth.

A prior research pass on #4791 recommended release-please. This ADR records the decision and
**re-grounds each of its falsifiable behavioural claims against release-please's own source**,
per the CLAUDE.md convention that platform/dependency behaviour is verified and cited, never
asserted (the convention exists because ADR 0040 rested on an unverified platform claim and
ADR 0082 had to tear out what grew on it). Where the source disagrees with the relayed claim,
the source wins and the correction is recorded below.

**Grounding basis.** release-please citations are read from the published
`release-please@17.11.1` tarball (`build/src/…`, the compiled output of the package the action
bundles) and from `googleapis/release-please-action` at tags `v4.4.1` and `v5.0.0`. The §6
rejection citations are read from `knope-dev/knope` at tag `versioning/v0.8.0` and `nrwl/nx` at
tag `23.1.1`.

## Decision

**release-please, in manifest mode, is the version-derivation mechanism: it partitions
conventional commits onto package roots by the files each commit touched, writes the derived
version and changelog into a standing Release PR, and never publishes — merging that PR is the
human release act, and the existing OIDC `pnpm publish` job on the release event is still the
only thing that ships a tarball.**

### 1. Routing is by changed file path, not by commit scope

release-please assigns a commit to a package by iterating the commit's touched files and
matching them against the configured package roots — `CommitSplit.split()` throws outright if
a commit arrives without `files`, and matches each file with
`this.packagePaths.find(p => file.indexOf(`${p}/`) === 0)`
(`build/src/util/commit-split.js`). The commit's `scope` is not consulted anywhere in that
path.

This is why the scope-vocabulary mismatch that motivated #4791 is a **non-problem for
routing**: this repo's commit scopes name areas of concern (`fix(pipeline): …`), not packages,
and under path routing that commit still bumps `fabrika-cli` correctly whenever its diff
touched `packages/fabrika-cli/`.

### 2. release-please never publishes

The `release-please` package contains no npm-publish path — no `npm publish`, no
`registry.npmjs.org`, no registry credential handling anywhere in `build/src/`. Its verbs
open pull requests and create GitHub releases. The publish step therefore stays exactly where
it already works: `.github/workflows/publish.yml`, on the `release: published` event, minting
a short-lived OIDC credential and running **`pnpm publish`** (ADR 0076 §2 — superseded by 0103
on packaging, not on the verb; see Context). The only change that workflow needs is resolving
*which* package from the release-tag prefix instead of hardcoding one — that is #4801's job,
not this ADR's.

### 3. ADR 0083 is not overturned — the Release PR carries both halves

ADR [0083](0083-agents-deploy-humans-release.md) rules that agents own deployment and humans
own release. That survives **by construction**, not by convention: release-please's output is
a pull request. Only the version *number* is automated. The decision to cut a release is
still a human merging the standing Release PR, and merging it is what creates the tag that
fires publish. No agent step tags, and no automation reaches the registry without that human
merge.

### 4. Per-package tags, grammar `<name>-v<version>`

The publishable packages are independent leaves — none depends on another — so a unified repo
version would move every package's number whenever any one of them changed. Versions are
per-package, tagged `<name>-v<version>`. This is the mechanical realization of ADR
[0201](0201-pipeline-tenant-phoenix-first.md) §4's independent release cadence (pipeline
artifacts version and release on their own tags, decoupled from phoenix app releases), and
that ruling stands unchanged — release-please is simply what now derives the number those tags
carry.

That grammar is what release-please emits by default for the node strategy, grounded in
source: `TagName.toString()` renders `${component}${separator}v${version}` with
`DEFAULT_SEPARATOR = '-'` and `includeV` defaulting true (`build/src/util/tag-name.js`), and
the node strategy's `normalizeComponent()` strips a leading `@scope/`
(`component.match(/^@[\w-]+\//) ? component.split('/')[1] : component`,
`build/src/strategies/node.js`), so `@kampus/pipeline-cli` yields the component
`pipeline-cli` and the tag `pipeline-cli-v0.2.1`. This matches the grammar `publish.yml`
already guards and the grammar `publish-isolation-guard` machine-reads out of that workflow
file to derive its own scope — so the mechanism lands on the existing convention rather than
migrating it.

### 5. The two hazards, and what each downstream child must do

**Hazard A — the repo-wide `releases_created` output.** The relayed claim was that
`releases_created` reports `true` whether or not a release happened. **A source read does not
support that claim and it is recorded here as not reproduced**: in
`release-please-action` v4.4.1, `outputReleases()` sets
`core.setOutput('releases_created', releases.length > 0)` after filtering undefined entries
(`src/index.ts`). The real hazard is a different and equally fatal one — `releases_created` is
**repo-wide**, true when *any* configured path released, and it says nothing about *which*.
Gating a per-package publish on it in a multi-package manifest publishes on a release of some
other package. The same function sets per-path outputs via
`setPathOutput(path, 'release_created', true)`, which emits `<path>--release_created` for
every path except the root `.`, plus a `paths_released` JSON array.

*Mitigation the wiring child (#4803) must implement:* gate on the per-path
`<path>--release_created` output (or iterate `paths_released`), never on the bare
`releases_created`.

**Hazard B — the first Release PR consumes all history.** release-please walks commits
backwards and stops early only on a configured boundary: `manifest.js` breaks the commit loop
on `this.lastReleaseSha === commit.sha`, or — when bootstrapping — on
`commit.sha === this.bootstrapSha`, both read from the config keys `last-release-sha` and
`bootstrap-sha` (`build/src/manifest.js`). With neither set, the first run has no boundary and
folds the entire backlog into one release.

*Mitigation the wiring child (#4803) must implement:* set the history boundary deliberately,
and read the first Release PR's commit range and derived version **before** merging it. This
is where the immutability constraint bites hardest — the first merge is the one that cannot
be taken back.

### 6. Rejected alternatives

- **knope** — routes by commit **scope**, grounded in source: a package's commits are selected
  by matching the commit's conventional-commit scope against that package's configured `scopes`
  list, and `changes_from_commit_message()` returns *no* changes when the scope is absent from
  it (`crates/knope-versioning/src/changes/conventional_commit.rs:44-53`, fed
  `self.scopes` by `Package::get_changes()` in `crates/knope-versioning/src/package.rs:111`).
  There is nothing to route on but the scope — the `Commit` struct that feeds change derivation
  carries only `message` and `info`, no touched-file list (`conventional_commit.rs:8-11`). That
  is precisely this repo's failure mode, so knope is disqualified on the exact axis §1 resolves.
- **Nx release** — the relayed claim was that pnpm catalogs are unsupported. **A source read
  does not support that claim and it is recorded here as not reproduced**: `@nx/js` resolves a
  `catalog:` specifier through `getCatalogManager()` / `isCatalogReference()` /
  `resolveCatalogReference()` and writes derived bumps back into the catalog definition with
  `updateCatalogVersions()` (`packages/js/src/release/version-actions.ts:174-181`, `:256-264`,
  `:319`). The rejection stands on adoption cost instead: Nx release derives versions from the
  **Nx project graph** and errors out without one, demanding the `@nx/js` plugin and a built
  graph (`:250-253`). Adopting it means adopting Nx as this repo's build system in place of
  turbo — far more than the version-derivation mechanism this ADR is choosing.
- **Lerna-Lite** — unverified on whether it rewrites `catalog:` into a tarball. Not needed:
  release-please never packs a tarball, so it cannot mishandle one.
- **changesets** — requires a per-PR changeset file. Agent-authored PRs forget artifacts;
  they cannot forget a file that does not exist. Path routing needs no artifact.

### 7. Boundary with ADR 0069 — two changelogs, two sources, no contest

ADR [0069](0069-derived-changelog-from-shipped-work.md) is live and implemented: `changelog.yml`
fires on the same `*-v*` release tag and regenerates the **root** `CHANGELOG.md` as a
projection of closed-issue and merged-PR pipeline metadata. release-please writes a
**per-package** `CHANGELOG.md` under each package root from conventional commits. These are
different files with different sources and different audiences — the root one narrates shipped
work to the repo, the per-package one narrates a version to a registry consumer. **ADR 0069's
ruling stands untouched**: nothing here re-derives the root changelog, and no downstream child
may point release-please at it.

**Binding constraints.**
- Publish is `pnpm publish`; `npm publish` is banned (`catalog:` would ship unresolved).
- No automation tags or publishes; only a human merging the Release PR does.
- Nothing publishes before the rename/manifest fix it depends on has landed on `main` — npm
  versions are immutable and a premature publish is permanent.
- Gate any per-package publish on the per-path `<path>--release_created` output.
- The first Release PR's commit range and derived version are read by a human before merge.
- Tags stay `<name>-v<version>`; `publish-isolation-guard` machine-reads that grammar out of
  `publish.yml`, so a rewrite that hides it zeroes a fail-closed gate (ADR
  [0092](0092-gates-fail-closed-on-zero-scope.md)).

**Banned.**
- A unified repo-wide version across the independent leaves.
- Gating publish on the repo-wide `releases_created` output.
- Pointing release-please at the root `CHANGELOG.md` (ADR 0069's artifact).

**Non-goal.** A PR-title scope allowlist or commit-convention guard is **not** a precondition
of this flow. Routing reads changed file paths (§1), so scope strings route nothing; scope
hygiene remains worth having for changelog readability alone, and may be pursued on its own
merits or not at all without blocking any of this.

## Consequences

- **Version numbers stop being hand-typed**, and the release tag stops being a thing a human
  can mistype relative to `package.json` — the Release PR writes both.
- **The human release gate gets cheaper, not weaker.** One PR merge per release replaces
  hand-editing a version, cutting a tag, and hoping they match.
- **Two control-plane PRs land downstream** (`.github/**` per ADR
  [0053](0053-control-plane-boundary.md)): the release-please workflow (#4803) and the
  generalized publish workflow (#4801). Both are human-merged.
- **The action major is an implementation detail, not part of this decision.** `v5.0.0`'s only
  breaking change over `v4.4.1` is the runner upgrade to node24; the manifest mechanism is
  unchanged. The wiring child picks the current major rather than inheriting a pin from this
  ADR.
- **A first-run mistake is permanent on the registry.** That is the cost of the immutability
  constraint, and it is why the history boundary and the first Release PR review are binding
  constraints rather than advice.

## Records

- **Vocabulary impact: none.** This ADR coins no term and redefines none. It reuses vocabulary
  the repo already owns — release-tag grammar, published-package set, control-plane,
  containment — plus standard release-engineering terms (Release PR, Trusted Publisher,
  bootstrap publish) that name industry mechanisms, not kamp.us concepts. Nothing is routed to
  `.glossary/TERMS.md`.
- **Contradiction sweep.** ADR 0069 is the one live `accepted` ADR that rules on an adjacent
  question (changelog production); §7 draws the boundary and 0069's ruling is untouched, so no
  supersede or amend-in-part is warranted. ADR 0201 §4 rules on release cadence and is realized,
  not re-decided (§4). ADRs 0064/0076/0103 rule on the publish half and are cited, not
  re-decided; 0083 is preserved by construction (§3).
- **Corrections recorded.** Two relayed claims are **not reproduced** against source: the
  `releases_created`-always-true claim (`release-please-action` v4.4.1 — §5 records the accurate
  hazard in its place) and the Nx-cannot-read-pnpm-catalogs claim (nx `23.1.1` — §6 records what
  the source actually does and re-grounds the rejection).
- **Provenance corrected.** An earlier draft attributed the npm-version-immutability constraint
  to ADR 0076. It does not appear there, and no ADR rules it: this ADR records it for the first
  time, on the evidence of the `@kampus/fabrika-cli@0.1.0` bootstrap near-miss (Context). The
  `pnpm publish` constraint does trace to 0076 §2, whose `superseded by 0103` status is marked
  at each citation because 0103 does not restate that ruling.
- Closes #4799.
