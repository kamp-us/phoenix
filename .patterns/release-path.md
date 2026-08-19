# The release path: derive a version, cut it by hand, publish on the tag

How a commit on `main` becomes a tarball on npm, and the constraints a change to that path
must not break. The *why* is ADR
[0239](../.decisions/0239-release-please-manifest-mode-version-derivation.md) — read it
when you want to revisit the mechanism; read this when you are about to change one of the
files below. The builder-facing procedure ("I want to cut a release") is
[DEVELOPMENT.md → Releasing](../DEVELOPMENT.md#releasing).

## The shape

Four surfaces, in the order a change flows through them:

| Surface | Role |
|---|---|
| [`release-please-config.json`](../release-please-config.json) + [`.release-please-manifest.json`](../.release-please-manifest.json) | The package roots, their tag components, and each one's currently-released version. The manifest is release-please's memory of where it left off. |
| [`.github/workflows/release-please.yml`](../.github/workflows/release-please.yml) | Runs on every push to `main`. Derives each package's next version from conventional commits and grooms one standing Release PR. Holds no registry credential and never publishes. |
| [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) | Runs on `release: published`. Resolves the tag prefix to a workspace member, typechecks, builds `dist/`, and `pnpm publish`es under an OIDC credential. |
| [`pipeline-cli publish-isolation-guard`](../packages/pipeline-cli/src/tools/publish-isolation-guard/gate.ts) | A PR gate that *machine-reads* `publish.yml` to derive which packages publish, then checks none of them links a private workspace member. |

The seam between the two workflows is a **git tag**, not a workflow call. Merging the
Release PR creates `<component>-v<version>` tags and their GitHub Releases; the
`release: published` event is what starts `publish.yml`. A `release` event carries exactly
one tag, so `publish.yml` is a single resolved job per package, never a fan-out. The same
event also starts [`changelog.yml`](../.github/workflows/changelog.yml), which is a
different concern (below).

Routing is by **changed file path**, not commit scope (ADR 0239 §1). release-please assigns
a commit to a package root by the files that commit touched. A commit written
`fix(pipeline-cli): …` whose diff only touches `packages/fabrika-cli/` bumps **fabrika-cli**.
Scope strings route nothing, so no commit-scope allowlist is a precondition of this path.

## Constraints a change must not break

Each of these has an enforcement site or a recorded ruling. Where a constraint has no live
ADR home, that is said plainly rather than papered over with a citation.

### 1. npm versions are immutable

A published version can never be corrected in place, only superseded by a higher one. Any
automation that can fire before a rename or a manifest fix has landed on `main` bakes the
error into the registry permanently.

Ruled by ADR [0239](../.decisions/0239-release-please-manifest-mode-version-derivation.md)
(Context), which records it for the first time on this repo's own evidence — the
`@kampus/fabrika-cli@0.1.0` bootstrap publish nearly shipped a retired command name from a
checkout that was behind the merge renaming it. **ADR 0076 does not rule this**; 0239 says
so explicitly, and an earlier draft's attribution to 0076 is recorded there as corrected.
Do not re-attribute it.

This is why the first Release PR is read before it is merged, and why the history boundary
below exists at all.

### 2. The publish verb is `pnpm publish`, never `npm publish`

Every dependency in this repo is a `catalog:` specifier (enforced by `catalog-guard`). npm
cannot resolve one and would ship the literal string `"catalog:"` as a dependency range —
a tarball nobody can install. pnpm resolves catalog and workspace specifiers into the
tarball at pack time, which is what lets the catalog stay the single source of truth.

Ruled by ADR [0076](../.decisions/0076-decisions-index-npm-publish-automated-release.md) §2.
0076 is `superseded by [0103]` on the *packaging* axis, and 0103 does not restate the verb
ruling — so superseded-0076 remains this constraint's only ADR home, cited as live on that
point alone (ADR 0239 §2 carries the same caveat).

### 3. The package ships compiled JS, never raw `.ts` — plus every asset `tsc` will not emit

Node refuses to strip types under `node_modules`, so a source-only tarball is dead on
arrival for a consumer. `bin`/`exports` point at `dist/`, `files` is `[dist]`, and
`publish.yml` runs an explicit build step before publishing (`prepublishOnly` also runs it;
the explicit step makes the gate visible).

`tsc` emits `.js`/`.d.ts` and copies nothing else, so a file under `src/` that no module
imports never reaches `dist/`. A module reading such a file by path off `import.meta.url`
therefore works in-tree and finds nothing in every install — invisible until someone runs the
published package, which is how `fabrika-cli` released a `lane open` that could boot no lane
at all ([#6011](https://github.com/kamp-us/phoenix/issues/6011)). A package whose build is
`tsc` alone carries a copy step after it
([`packages/fabrika-cli/scripts/copy-src-assets.mjs`](../packages/fabrika-cli/scripts/copy-src-assets.mjs)),
and the rule that step applies is **every** non-`.ts` file with no exception list: an
exception list is maintained by whoever adds an asset knowing that reading a file by path is
different from importing it, which is exactly the knowledge the defect proves absent.

Only a build-and-pack test can see this — read from `src/`, the asset is right there. The
worked one is
[`packages/fabrika-cli/src/packaging.cli.test.ts`](../packages/fabrika-cli/src/packaging.cli.test.ts):
it runs the real build, packs the real tarball, and drives the tarball's own `dist/bin.js`.
The two sibling published packages do not have it yet
([#6039](https://github.com/kamp-us/phoenix/issues/6039)).

**No live ADR rules this.** It is written down in ADR 0076 §1, which is superseded and
which 0103 does not restate on this point, and in `publish.yml`'s own comment citing
[#405](https://github.com/kamp-us/phoenix/issues/405). Treat those two as its home until an
ADR picks it up.

### 4. The pnpm version is pinned once, in the root `packageManager`

`package.json`'s `"packageManager": "pnpm@10.27.0"` is the single pin.
`.github/workflows/publish.yml` uses `pnpm/action-setup@v4.1.0` with **no `version:` input,
and must not add one** — `v4.1.0` pins the *action*, not pnpm, and a `version:` input would
be a second pin that drifts from the root the moment the root bumps.

pnpm 11 is excluded because of a known OIDC trusted-publishing 404 regression
([pnpm#11513](https://github.com/pnpm/pnpm/issues/11513)); that exclusion is recorded as a
comment at the workflow's setup step, which is where a reader changing the pin will be.

> ADR 0076's *title* says `pnpm/action-setup` was pinned to 10.27.0. 0076 is superseded, and
> the workflow file is authoritative over both it and this doc. Do not reintroduce a
> `version:` input on 0076's authority.

### 5. Gate per-package work on the per-path output, never `releases_created`

`releases_created` is **repo-wide**: true when *any* configured path released, silent about
which. It is not "always true" — `release-please-action` sets it to `releases.length > 0` —
which makes it worse rather than better, because it looks trustworthy while gating a
pipeline-cli action on a fabrika-cli release.

`release-please.yml`'s only condition keys on the per-path
`<path>--release_created` outputs (`packages/pipeline-cli--release_created`,
`packages/fabrika-cli--release_created`) and reports from the `paths_released` JSON array.
`releases_created` appears nowhere in the file, deliberately. A later "simplification" back
to the single output is the regression ADR 0239 §5 Hazard A names.

### 6. The tag grammar is a machine-read contract, not a convention

Tags are `<unscoped-name>-v<version>`. `publish.yml`'s resolve step holds the tag-match arms
as **literal anchored regexes**, and `publish-isolation-guard` parses that file to derive
which packages publish — the arms are the single source of truth for the published set.

So: adding an arm widens the guard's scope automatically, dropping one narrows it, and
moving the grammar behind a shell variable or an external file zeroes the guard, which then
fails closed (ADR [0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md)) rather than
passing vacuously. `release-please-config.json`'s `component` values must stay in lockstep
with those arms, since they are what produce the tags the arms match.

Per-package tags (not one repo-wide version) are ADR 0239 §4, realizing ADR
[0201](../.decisions/0201-pipeline-tenant-phoenix-first.md) §4's independent cadence: the
publishable packages are independent leaves, so a unified version would move every number
whenever any one changed.

### 7. Two changelogs, two owners

`changelog.yml` owns the **root** `CHANGELOG.md`, derived from pipeline metadata on the same
`*-v*` release tag (ADR [0069](../.decisions/0069-derived-changelog-from-shipped-work.md)).
release-please writes **per-package** `CHANGELOG.md` files under each package root from
conventional commits. Different files, different sources, different audiences.

**Pointing release-please at the root `CHANGELOG.md` is banned** (ADR 0239 §7 / Banned).

### 8. Only the number is automated — a human still cuts the release

release-please's output is a pull request. Nothing tags and nothing reaches the registry
without a human merging it. That preserves ADR
[0083](../.decisions/0083-agents-deploy-humans-release.md) by construction rather than by
convention: do not add automation that merges the Release PR.

Both workflow files are `.github/**`, so changes to them are control-plane PRs a human
merges (ADR [0053](../.decisions/0053-control-plane-boundary.md)).

### 9. Trusted Publishing binds to the exact workflow filename

Auth is OIDC Trusted Publishing — there is **no `NPM_TOKEN` secret and no token fallback**.
Each package's registration on npmjs.com names this repo *and this workflow file*, so
renaming `publish.yml`, or splitting it into a second publish workflow, silently invalidates
every existing registration. The failure surfaces as a 403 at publish time, after install
and build have already passed.

That is also why one file resolves the tag rather than one workflow per package.

**The environment field is part of that binding, and it is the easier half to break.**
`publish.yml` declares no `environment:` key, and the `fabrika-cli` registration recorded on
[#4800](https://github.com/kamp-us/phoenix/issues/4800) was made with npm's environment field
deliberately left empty so the OIDC claim matches. A change that adds an `environment:` to
`publish.yml` **must edit the registrations on npmjs.com in the same change** — otherwise the
claim stops matching and publishing breaks with the same late 403, with nothing about the
workflow looking wrong.

## Adding a third published package

Publishing a new `@kampus/*` package is **not** a code-only change: it needs a one-time human
step on npmjs.com and a first publish that CI cannot perform. In order:

1. **Make the package publishable.** Remove `"private": true`; set `publishConfig.access:
   public`, `license`, `repository`; point `bin`/`exports` at `dist/` and set `files: [dist]`;
   add `build` (compile `src/` → `dist/`) and `prepublishOnly` scripts. Constraint 3 applies.
2. **Add the resolve arm** to `.github/workflows/publish.yml` — a literal anchored
   `^<name>-v([0-9].*)$` regex mapping to the package directory. This is what widens
   `publish-isolation-guard`'s scope (constraint 6), so the guard now checks this package too.
3. **Add the package root** to `release-please-config.json` (`component: <unscoped-name>`) and
   an entry to `.release-please-manifest.json` at its current version. Add its per-path
   `<path>--release_created` output to `release-please.yml`'s condition — constraint 5 means
   it cannot inherit another package's gate.
4. **Bootstrap-publish the first version by hand** (`pnpm publish` from the package
   directory, from a checkout that is **at** the merge you intend to ship — constraint 1).
   Trusted Publishing cannot be registered for a package that does not exist on the registry
   yet, so CI cannot perform this first publish.
5. **Register the Trusted Publisher** on npmjs.com (Settings → Publishing) for the new
   package: this repo, workflow file `publish.yml`. Until this is done, every CI publish of
   that package 403s at the OIDC step — after install, typecheck and build have all passed.
   That lateness is the shape of the failure, not evidence of a broken build.

Between steps 3 and 5 the path is **fail-closed and expected to be red** for the new package:
a Release PR merge can create its tag, and that tag's publish run will 403. Nothing is
corrupted by it — no version is consumed, because nothing was published.

## Current state

Both published packages have an npm Trusted Publisher registration naming this repo and this
workflow file — but only one of them has ever been *exercised* by it, and those are two
different facts.

- **`pipeline-cli` — proven by exercise.** Its registration has carried two green `publish.yml`
  release runs, and the published artifact carries the publish attestations
  (`npm view @kampus/pipeline-cli --json` → a `dist.attestations` key) that only an OIDC publish
  stamps.
- **`fabrika-cli` — recorded, never exercised.** The registration is recorded on
  [#4800](https://github.com/kamp-us/phoenix/issues/4800), which pastes npm's own confirmation
  of it, and `publish.yml` has since gained its resolve arm — but no publish run has ever fired
  for the package. `fabrika-cli@0.1.0` reached the registry through the bootstrap `pnpm publish`
  of step 4 above, not through this path (its artifact carries no attestations). Its **first**
  release run is the first use of that registration, and that run is the proof.

That record is the authority, because nothing here can re-derive it: npm exposes no
trusted-publisher field over the CLI or the registry API, so registration state is a web-UI
fact and npmjs.com (Settings → Publishing) is the only place to check it. Never restate it as
tool-verified.

So expect no outcome in either direction for that first run. If it 403s, the path failed closed:
nothing was published, **no version number is burned**, and re-running the release after fixing
the registration recovers cleanly.

Because `release-please-config.json` sets `separate-pull-requests: false`, one Release PR can
carry both packages and its merge can create both tags — two publish runs, one over a
registration proven by exercise and one over a registration being used for the first time.
