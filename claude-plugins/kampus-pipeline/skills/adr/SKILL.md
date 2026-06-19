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
       gh api "repos/$REPO/pulls/$PR/files?per_page=100" \
         --jq '.[] | select(.status=="added") | .filename
               | capture("^\\.decisions/(?<n>[0-9]{4})-") | .n'
     done
     ```
     (`$REPO` resolves the same way write-code's does: `${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}`.) **Fail closed** (ADR 0074, ADR 0059's fail-closed acquire): if the in-flight query errors, **surface it and re-run** — never silently fall back to the on-disk-only number. That stale-on-disk fall-back is the bug this step removes.

   This is **detect-and-serialize, not a CAS** — it *narrows* the collision window, it does not eliminate it. Two authors who enumerate in the same window before either PR is visible both pick the same number; that residual is **backstopped by the ADR 0066 / #384 CI duplicate-`id` check** (see [Index — generated output](#index--generated-output)), which reddens the second-to-merge PR for a manual renumber. The lock turns the *common* "branch after another's ADR PR is open" case from collide-and-renumber into don't-collide; the CI check remains the safety net for the rare residual.
2. Pick a kebab-case slug from the title (≤ 5 words).
3. Write `.decisions/NNNN-slug.md` using the template below — the front-matter `title`/`status`/`date` are the **source of truth** for the index row, so write the exact display text you want in the table there (inline markdown and all).
4. **Regenerate** `.decisions/index.md` — do **not** hand-append a row (ADR [0066](https://github.com/kamp-us/phoenix/blob/main/.decisions/0066-generate-decisions-index.md)): `index.md` is generated output now, and a hand-appended row at the table tail is exactly the concurrent-merge collision the generator removes. Resolve the generator **in-repo first, published fallback** — prefer the on-disk workspace package when it's present, else the published CLI (the same portability shape `review-plan` uses for its gate, ADR [0064](https://github.com/kamp-us/phoenix/blob/main/.decisions/0064-epic-ledger-npm-publish-automated-release.md)), so the step works in a foreign install too, not just phoenix:
   ```bash
   # resolve the index generator once — in-repo-first, published-fallback
   if [ -f packages/decisions-index/src/bin.ts ]; then
     pnpm --filter @kampus/decisions-index generate    # phoenix-local: the workspace package
   else
     pnpm dlx @kampus/decisions-index@latest generate   # foreign install: the published CLI
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

`.decisions/index.md` is a heading + a markdown table, **regenerated** from the ADR files by `@kampus/decisions-index` (ADR [0066](https://github.com/kamp-us/phoenix/blob/main/.decisions/0066-generate-decisions-index.md)) — never hand-edited. Each row is derived from one file's front-matter (`id` → linked `title` → `status` → `date`), ordered ascending by `id`:

```markdown
# Decisions

One row per ADR. Read the file for the why.

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](0001-slug.md) | Title | accepted | YYYY-MM-DD |
```

The row's `Title`/`Status`/`Date` cells are the file's front-matter values **verbatim** — so a linked supersede status (`superseded by [0009](0009-slug.md)`) is written in the file's `status:` field, and the generator carries it into the table. CI (`.github/workflows/decisions-index.yml`) runs `decisions-index check` on every PR: a stale index (you forgot to regenerate) or a duplicate `id` (two PRs grabbed the same number) fails the build.

## Rules

- One decision per file. If the user is describing a sprawling design, that belongs in the vault, not here.
- `status`: `accepted | proposed | superseded | deprecated` (or a richer linked phrase like `superseded by [NNNN](NNNN-slug.md)`). Default `accepted` unless the user says otherwise. Whatever you put in `status:` is what the index shows.
- Superseding an older ADR: in the new file write `Supersedes [NNNN](NNNN-slug.md).` in `## Context`, and edit the old file's front-matter `status: superseded by [NNNN](NNNN-slug.md)` plus a body line `Superseded by [NNNN](NNNN-slug.md).` Then regenerate so the index reflects both.
- Date is today (`date` command if unsure).
- Never edit an accepted ADR's decision text after the fact — supersede instead.
- Never hand-edit `index.md` — edit the ADR file's front-matter and regenerate, resolving the generator in-repo-first / published-fallback (Step 4): `pnpm --filter @kampus/decisions-index generate` when the workspace package is on disk, else `pnpm dlx @kampus/decisions-index@latest generate`.
