---
name: adr
description: Record an architecture decision in `.decisions/`. Trigger when the user says "/adr", "save this as an ADR", "record this decision", "ADR for X", or after a meaningful technical preference / convention is stated that future agents should respect.
---

# adr

Capture one decision per file in `.decisions/`. Index links them; CLAUDE.md links the index. Future agents start at the index and read only what they need.

## Steps

1. Read `.decisions/index.md` to find the next number. Numbers are 4-digit zero-padded, monotonic.
2. Pick a kebab-case slug from the title (≤ 5 words).
3. Write `.decisions/NNNN-slug.md` using the template below — the front-matter `title`/`status`/`date` are the **source of truth** for the index row, so write the exact display text you want in the table there (inline markdown and all).
4. **Regenerate** `.decisions/index.md` — do **not** hand-append a row (ADR [0066](../../.decisions/0066-generate-decisions-index.md)): `index.md` is generated output now, and a hand-appended row at the table tail is exactly the concurrent-merge collision the generator removes.
   ```bash
   pnpm --filter @kampus/decisions-index generate
   ```
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

`.decisions/index.md` is a heading + a markdown table, **regenerated** from the ADR files by `@kampus/decisions-index` (ADR [0066](../../.decisions/0066-generate-decisions-index.md)) — never hand-edited. Each row is derived from one file's front-matter (`id` → linked `title` → `status` → `date`), ordered ascending by `id`:

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
- Never hand-edit `index.md` — edit the ADR file's front-matter and run `pnpm --filter @kampus/decisions-index generate`.
