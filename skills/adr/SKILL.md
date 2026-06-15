---
name: adr
description: Record an architecture decision in `.decisions/`. Trigger when the user says "/adr", "save this as an ADR", "record this decision", "ADR for X", or after a meaningful technical preference / convention is stated that future agents should respect.
---

# adr

Capture one decision per file in `.decisions/`. Index links them; CLAUDE.md links the index. Future agents start at the index and read only what they need.

## Steps

1. Read `.decisions/index.md` to find the next number. Numbers are 4-digit zero-padded, monotonic.
2. Pick a kebab-case slug from the title (≤ 5 words).
3. Write `.decisions/NNNN-slug.md` using the template below.
4. Append one row to `.decisions/index.md` (under the table). Keep newest at the bottom.
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

## Index template

`.decisions/index.md` is just a heading + a markdown table:

```markdown
# Decisions

One row per ADR. Read the file for the why.

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](0001-slug.md) | Title | accepted | YYYY-MM-DD |
```

## Rules

- One decision per file. If the user is describing a sprawling design, that belongs in the vault, not here.
- `status`: `accepted | proposed | superseded | deprecated`. Default `accepted` unless the user says otherwise.
- Superseding an older ADR: in the new file write `Supersedes [NNNN](NNNN-slug.md).` in `## Context`, and edit the old file's frontmatter `status: superseded` plus a body line `Superseded by [NNNN](NNNN-slug.md).`
- Date is today (`date` command if unsure).
- Never edit an accepted ADR's decision text after the fact — supersede instead.
