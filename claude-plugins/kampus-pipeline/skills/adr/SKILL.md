---
name: adr
description: Record an architecture decision in `.decisions/`. Trigger when the user says "/adr", "save this as an ADR", "record this decision", "ADR for X", or after a meaningful technical preference / convention is stated that future agents should respect.
---

# adr

Capture one decision per file in `.decisions/`. Index links them; CLAUDE.md links the index. Future agents start at the index and read only what they need.

## Steps

1. **Claim the next number with an in-flight reservation lock** (ADR [0074](https://github.com/kamp-us/phoenix/blob/main/.decisions/0074-adr-number-claim-lock.md)) — not next-free-on-disk. Numbers are 4-digit zero-padded, monotonic. Compute the next number from the **union of two sets** and take `max(union) + 1`:
   - **Merged set** — the `NNNN` on the base ref, read from the `.decisions/NNNN-*.md` *filenames* (the authority; `index.md` is generated output per ADR [0066](https://github.com/kamp-us/phoenix/blob/main/.decisions/0066-generate-decisions-index.md) and merely mirrors them).
   - **In-flight set** — the `NNNN` **claimed by open ADR PRs**. An open PR that adds a `.decisions/NNNN-*.md` file *is* the reservation for `NNNN` (no separate artifact, exactly as ADR 0059's `status:planning` label *is* the epic lock — opening the PR reserves, merging/closing releases). Enumerate via **`gh api` REST, never GraphQL** (the org's Projects-classic integration breaks GraphQL):
     ```bash
     # NNNN claimed by any open PR that ADDS a .decisions/00NN-*.md file (REST, per-PR files endpoint)
     for PR in $(gh api "repos/$REPO/pulls?state=open&per_page=100" --jq '.[].number'); do
       gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" \
         --jq '.[] | select(.status=="added") | .filename
               | capture("^\\.decisions/(?<n>[0-9]{4})-") | .n'   # --paginate + streaming --jq: a >100-file PR that adds .decisions/NNNN past file #100 still claims its number (the API caps per_page at 100; #725)
     done
     ```
     (`$REPO` resolves the same way write-code's does: `${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}`.) **Fail closed** (ADR 0074, ADR 0059's fail-closed acquire): if the in-flight query errors, **surface it and re-run** — never silently fall back to the on-disk-only number. That stale-on-disk fall-back is the bug this step removes.

   This is **detect-and-serialize, not a CAS** — it *narrows* the collision window, it does not eliminate it. Two authors who enumerate in the same window before either PR is visible both pick the same number; that residual is **backstopped by the ADR 0066 / #384 CI duplicate-`id` check** (see [Index — generated output](#index--generated-output)), which reddens the second-to-merge PR for a manual renumber. The lock turns the *common* "branch after another's ADR PR is open" case from collide-and-renumber into don't-collide; the CI check remains the safety net for the rare residual.
2. Pick a kebab-case slug from the title (≤ 5 words).
3. Write `.decisions/NNNN-slug.md` using the template below — the front-matter `title`/`status`/`date` are the **source of truth** for the index row, so write the exact display text you want in the table there (inline markdown and all).
4. **Do not regenerate or commit `.decisions/index.md` in your PR.** The index is generated output (ADR [0066](https://github.com/kamp-us/phoenix/blob/main/.decisions/0066-generate-decisions-index.md)) and is regenerated + committed **on merge to main** by the `decisions-index` workflow's `regenerate` job (issue [#1492](https://github.com/kamp-us/phoenix/issues/1492)). Your PR is **purely additive** — it adds only `.decisions/NNNN-slug.md`. This is the point of #1492: when ADR PRs don't carry the regenerated index, two concurrent ADR PRs can't collide on it, so adding an ADR is conflict-free instead of an O(N) serialized re-review treadmill. If you want to **preview** the resulting table locally you may run the generator, but **do not stage or commit** its output — resolve it in-repo-first, published-fallback (the same portability shape `review-plan` uses for its gate, ADR [0064](https://github.com/kamp-us/phoenix/blob/main/.decisions/0064-epic-ledger-npm-publish-automated-release.md)):
   ```bash
   # OPTIONAL local preview only — never `git add .decisions/index.md` (the merge job owns it)
   if [ -f packages/pipeline-cli/src/bin.ts ]; then
     node packages/pipeline-cli/src/bin.ts decisions-index generate   # phoenix-local: the in-repo consolidated bin
   else
     pnpm dlx @kampus/pipeline-cli@0.1.0 decisions-index generate      # foreign install: the published consolidated CLI (single-source pin)
   fi
   ```
   The published CLI operates on the local `.decisions/` filesystem (no GitHub target), so there is no `$REPO`/`$CLAUDE_PIPELINE_REPO` resolution here — it is purely the in-repo-vs-published invocation swap.
5. Tell the user the path. Do not summarize the body — they just stated it.

## File template

```markdown
---
id: NNNN
title: <Title Case>
status: accepted
date: YYYY-MM-DD
tags: [<area>, <area>]
---

# NNNN — <Title>

## Context
<Why this came up — situation, constraint, prior pain.>

## Decision
<What we do now, declarative. No hedging.>

## Consequences
<What this makes easier / harder. What's now banned. Any migration cost.>
```

## Index — generated output

`.decisions/index.md` is a heading + a markdown table, **regenerated** from the ADR files by pipeline-cli's `decisions-index` tool (ADR [0066](https://github.com/kamp-us/phoenix/blob/main/.decisions/0066-generate-decisions-index.md)) — never hand-edited. Each row is derived from one file's front-matter (`id` → linked `title` → `status` → `date`), ordered ascending by `id`:

```markdown
# Decisions

One row per ADR. Read the file for the why.

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](0001-slug.md) | Title | accepted | YYYY-MM-DD |
```

The row's `Title`/`Status`/`Date` cells are the file's front-matter values **verbatim** — so a linked supersede status (`superseded by [0009](0009-slug.md)`) is written in the file's `status:` field, and the generator carries it into the table. The index is **not committed in PRs** (issue [#1492](https://github.com/kamp-us/phoenix/issues/1492)) — it is regenerated and committed on merge to main by the `regenerate` job of `.github/workflows/decisions-index.yml`, so an ADR PR adds only its `.decisions/NNNN-*.md` and never conflicts on the shared index. On a **PR** that same workflow runs `decisions-index validate`, which fails the build on a duplicate `id` or a filename/front-matter number mismatch (two PRs grabbed the same number — #1471) but does **not** check index freshness.

## Rules

- One decision per file. If the user is describing a sprawling design, that belongs in the vault, not here.
- `status`: `accepted | proposed | superseded | deprecated` (or a richer linked phrase like `superseded by [NNNN](NNNN-slug.md)`). Default `accepted` unless the user says otherwise. Whatever you put in `status:` is what the index shows.
- Superseding an older ADR: in the new file write `Supersedes [NNNN](NNNN-slug.md).` in `## Context`, and edit the old file's front-matter `status: superseded by [NNNN](NNNN-slug.md)` plus a body line `Superseded by [NNNN](NNNN-slug.md).` The on-merge `regenerate` job reflects both in the index — you don't touch `index.md`.
- Date is today (`date` command if unsure).
- Never edit an accepted ADR's decision text after the fact — supersede instead.
- Never hand-edit `index.md`, and **don't commit it in your PR** — edit the ADR file's front-matter only; the index is regenerated and committed on merge to main (issue #1492). Local preview (optional, never staged): `node packages/pipeline-cli/src/bin.ts decisions-index generate` when the consolidated bin is on disk, else `pnpm dlx @kampus/pipeline-cli@0.1.0 decisions-index generate`.
