---
id: 0062
title: Repo-as-config for the distributable plugin — the target repo is resolved from the working git repo (env override), the pipeline ships repo-agnostic; epic-ledger is the one acknowledged-pinned piece for v1
status: accepted
date: 2026-06-15
tags: [plugin, pipeline, packaging, repo-agnostic, skills]
---

# 0062 — Repo-as-config for the distributable plugin

## Context

Epic [#228](https://github.com/kamp-us/phoenix/issues/228) packages the `.claude/skills/`
issue-pipeline suite (`report → triage → plan-epic → review-plan → write-code →
review-code`/`review-doc` → `ship-it`, plus `heal-ci`, `adr`, `deslop-comments`) as an
**installable, repo-agnostic** Claude Code plugin. The goal is explicit: an adopter
installs the suite into *their own* repo and the pipeline operates on *their* issues.

Today the suite is hard-pinned to `kamp-us/phoenix`:

- ~105 `gh api repos/kamp-us/phoenix/...` literals across 9 skills.
- 7 skills name `kamp-us/phoenix` in their trigger `description:` frontmatter.
- `review-plan` (and the gate it drives) shells out to the in-repo `@phoenix/epic-ledger`
  CLI under `packages/` — a package that does not exist in a foreign checkout.
- Skills cite phoenix docs outside the bundled `skills/` tree (`../../../.decisions/*`,
  `.patterns/*`, `CLAUDE.md`) as rationale — relative links that dangle once installed
  elsewhere.

"Make it a plugin" is therefore not mechanical: it forces a set of genuine forks —
*how* a host repo's target is supplied, *which* skills can be portable, *how* the package
dependency travels, *how* external doc-references resolve, and *how* a phoenix maintainer
who installs the plugin avoids seeing every skill twice (the cross-scope discovery
collision, [#346](https://github.com/kamp-us/phoenix/issues/346), upstream
anthropics/claude-code#53923, which has no per-project plugin disable). This ADR settles
those forks so the de-pin implementation children (#348, #351, #349, #350) and the layout
child (#231) build against a decided design instead of guessing.

The portability *target* is not relitigated here: the epic already decided
**repo-agnostic**. This ADR decides the *mechanism* and the dependent dispositions.

## Decision

### 1. The target repo is resolved from the working git repository, with an env override

Every `gh api repos/kamp-us/phoenix/...` literal becomes `gh api repos/$REPO/...`, where
`$REPO` (`owner/name`) is resolved, in order:

1. **`$CLAUDE_PIPELINE_REPO`** if set (format `owner/name`) — the explicit override, for
   fork workflows or when the working dir's origin is not the target.
2. Otherwise **the current repository**, derived from
   `gh repo view --json nameWithOwner -q .nameWithOwner` (which reads the `origin` remote).

```bash
# the one resolution snippet every parameterized skill uses
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

Rationale: the default-by-derivation makes the common case **zero-config** — the pipeline
operates on whatever repo you are working in, which is what an adopter wants and what
phoenix itself wants (in phoenix, `gh repo view` resolves to `kamp-us/phoenix`, so the
behavior is unchanged with no config). An env var, not a checked-in config file, is the
override because a config file is itself a per-repo artifact the adopter would have to author
and keep in sync, whereas the derivation needs nothing. This mirrors the capability-at-the-
boundary discipline the rest of the suite already uses for `gh`.

This is **not** a code refactor of a typed config object — the skills are markdown
procedures, so "config" here is the resolution snippet above, stated once in the shared
[`gh-issue-intake-formats.md`](https://github.com/kamp-us/phoenix/blob/main/.claude/skills/gh-issue-intake-formats.md)
contract and referenced by each skill, replacing the inline literals.

### 2. Per-skill portability classification

| Skill | Disposition | Why |
|-------|-------------|-----|
| `adr` | **portable as-is** | zero repo literals; pure `.decisions/` authoring |
| `deslop-comments` | **portable as-is** | zero repo literals; operates on the working tree |
| `report` | **parameterized** (§1) | `gh api` literals + frontmatter |
| `triage` | **parameterized** (§1) | `gh api` literals + frontmatter |
| `plan-epic` | **parameterized** (§1) | `gh api` literals + frontmatter |
| `review-code` | **parameterized** (§1) | `gh api` literals + frontmatter |
| `review-doc` | **parameterized** (§1) | `gh api` literals + frontmatter |
| `write-code` | **parameterized** (§1) | `gh api` literals + frontmatter |
| `ship-it` | **parameterized** (§1) | `gh api` literals + frontmatter |
| `heal-ci` | **parameterized** (§1) | `gh api` literals |
| `review-plan` | **parameterized (§1); epic-ledger-pinned for v1, now portable** | needed `@phoenix/epic-ledger`; the §3 deferral is resolved by [0064](0064-epic-ledger-npm-publish-automated-release.md) — the gate runs the published `@kampus/epic-ledger` in a foreign repo, so the suite is now **11/11** repo-agnostic (see §3 note + Consequences) |

### 3. `@phoenix/epic-ledger` — review-plan stays phoenix-pinned for v1; npm-publish is the deferred follow-up

> **Superseded by [0064](0064-epic-ledger-npm-publish-automated-release.md).** The
> deferral below is resolved: epic-ledger is published to npm (renamed
> `@kampus/epic-ledger`) via an automated release pipeline, and `review-plan` resolves
> the in-repo package first, falling back to the published one. The §3 degradation guard
> is removed. The rest of this ADR (§1, §2, §4, §5) stands.

`review-plan`'s deterministic gate is `@phoenix/epic-ledger` (`packages/epic-ledger`), an
Effect CLI run with `node packages/epic-ledger/src/bin.ts`. Three options were weighed:
bundle the package into the plugin, publish it to npm and invoke via `pnpm dlx`, or exclude
`review-plan` from the portable set.

**Decision: v1 ships `review-plan` parameterized for its `gh api` calls but still dependent
on the in-repo package — i.e. fully functional only inside phoenix — and degrading with a
clear message elsewhere.** Publishing `@phoenix/epic-ledger` to npm (so a foreign
`review-plan` can `pnpm dlx` it) is scoped as a **deferred follow-up epic**, not this epic's
work.

Rationale: bundling drags an Effect dependency tree into a markdown-skills plugin (wrong
shape, heavy); publishing requires standing up an npm release pipeline (real work, its own
epic). Excluding `review-plan` entirely loses the plan-gate for adopters needlessly when the
other 10 skills are portable now. The honest v1 slice is: every skill that *can* be
zero-cost repo-agnostic **is**, and the one skill with a hard compiled-package dependency is
explicitly the single acknowledged-pinned piece — invoking it in a foreign repo prints
`review-plan requires @phoenix/epic-ledger (not available in this install — see ADR 0062 §3)`
rather than a raw module-not-found. This is the cheapest-correct slice; it does not strand
the rest of the suite on the hardest dependency.

### 4. External doc-references are rewritten to stable GitHub URLs

References that escape the bundled `skills/` tree — `../../../.decisions/*`, `.patterns/*`,
`CLAUDE.md` — are **rewritten to absolute `https://github.com/kamp-us/phoenix/blob/main/...`
permalinks**, not bundled.

Rationale: these references cite phoenix's *own* ADRs and pattern docs as the rationale
behind a skill's design (e.g. "see ADR 0047 for the gate architecture"). That rationale is
phoenix-specific knowledge an adopter reads for understanding, not a file the adopter's repo
needs to contain — so a stable link is correct and bundling N phoenix ADRs into every
install is wrong (it would imply the adopter owns those decisions). Intra-suite links
(sibling `SKILL.md`, the shared `gh-issue-intake-formats.md`) stay **relative** — they
travel inside `skills/` and are #231's concern, not this rewrite.

### 5. In-repo discovery doubling — accept the doubles for v1, documented

With the plugin installed at user scope, a phoenix maintainer working *inside phoenix* sees
every skill twice — bare `report` (project-scope `.claude/skills/`) and `phoenix:report`
(plugin scope) — because Claude Code does not dedupe skill names across scopes and offers no
per-project plugin disable (anthropics/claude-code#53923).

**Decision: accept the doubles for v1, with a documented recommendation that phoenix
maintainers rely on the local `.claude/skills/` discovery and do *not* install the plugin
*into phoenix itself*** (they already have the canonical suite locally; the plugin exists for
*other* repos). The README states this. Revisit if/when upstream ships a per-project plugin
toggle.

Rationale: the two clean alternatives both cost more than the problem is worth in v1 —
dropping local `.claude/skills/` discovery in favor of the installed plugin would make
phoenix's daily pipeline depend on a published artifact (fragile, and breaks the dogfood
edit-locally loop), and there is no per-project suppression to configure. Accepting the
doubles is a documentation cost, not a functional one; phoenix maintainers simply don't
install-into-self.

### 6. Scope split — what is this epic vs deferred

**In epic #228:** the config mechanism (§1), the `gh api` + frontmatter de-pin of the 9
parameterizable skills (§2), the external doc-reference rewrite (§4), the discovery-doubling
disposition (§5), the `skills/` layout, the manifests, and the repo-agnostic install-and-use
validation.

**Deferred to a follow-up epic:** publishing `@phoenix/epic-ledger` to npm so `review-plan`
becomes portable (§3). Until then `review-plan` is the one phoenix-pinned skill.

> **Resolved.** That follow-up epic shipped — [#362](https://github.com/kamp-us/phoenix/issues/362)
> (ADR [0064](0064-epic-ledger-npm-publish-automated-release.md)) published
> `@kampus/epic-ledger` and cut `review-plan` over to in-repo-first / published-fallback
> resolution; [#408](https://github.com/kamp-us/phoenix/issues/408) made the published gate
> resolve its target repo from `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` → `gh repo view`
> (fail-closed). `review-plan` is **no longer phoenix-pinned** — the suite is **11/11
> repo-agnostic**, proven end-to-end against a real non-phoenix repo in
> [#368](https://github.com/kamp-us/phoenix/issues/368).

## Consequences

- The de-pin children (#348 tracer, #351 sweep) implement §1 against a single resolution
  snippet; their "no `kamp-us/phoenix` literal remains" acceptance criteria carve out the
  §3/§4 intentionally-pinned references (the epic-ledger note and the rewritten-URL hosts).
- `#349` implements §3 (the graceful-degradation message + the deferred-publish note);
  `#350` implements §4 (the URL rewrite); `#231` implements §5 (and records "accept doubles"
  as the chosen outcome).
- phoenix's own pipeline is unchanged: `CLAUDE_PIPELINE_REPO` unset + `gh repo view` →
  `kamp-us/phoenix`, and the in-repo `@phoenix/epic-ledger` keeps `review-plan` fully
  functional locally.
- An adopter gets 10 of 11 skills fully repo-agnostic on install, `review-plan` degrading
  with a clear message, and a README stating the boundary and the install-into-self caveat.
  *(Superseded by [0064](0064-epic-ledger-npm-publish-automated-release.md) / #362: the
  adopter now gets **all 11** repo-agnostic — `review-plan` runs the published
  `@kampus/epic-ledger` in a foreign repo instead of degrading, validated end-to-end in
  #368. The install-into-self caveat (§5) stands.)*
- The one residual sharp edge is the env-var override's blast radius: a stale
  `CLAUDE_PIPELINE_REPO` pointed at the wrong repo would silently operate the pipeline on
  that repo. The resolution snippet's default-to-current-repo keeps the common path safe; the
  override is opt-in and documented as such.
