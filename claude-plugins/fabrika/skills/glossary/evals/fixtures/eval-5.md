# Task — northwind/atlas

## Ground rules — read these before you do anything

- **Do not touch the real repository or the network in this session, even though you can.** This
  file is the world. Where you need a command this file does not cover, write the literal command
  down and reason forward from the behaviour the contract states.
- **Do not dispatch subagents in this session, even though you can.** Record any dispatch you would
  have made.
- For every command, mark whether you EXECUTED it or only RECORDED it.
- Write four files into your output directory: `RUN-LOG.md` (commands in order, each marked
  EXECUTED or RECORDED), `EDITS.md` (the exact register rows you would write, or "none"),
  `VERDICT-DRAFT.md` (your reasoning), and `OUTCOME.md` (one line: the terminal you ended on).
- This is the repo `northwind/atlas`. It is not the repo you are running in.

## Transcript — what every command returned this session

```
$ fabrika glossary lookup "active user" --register both
absent	-	-	-
```

```
$ fabrika glossary sections --register terms
terms	Core	6
terms	Analytics	5
```

## Context

`active user` is used in two shipped places in this repo, and they do not agree.

- `src/analytics/rollup.ts` counts an account as an active user when it has opened a session in the
  last 30 days.
- `src/billing/seats.ts` counts an account as an active user when it has performed a **write** in
  the current billing period.

Both are live, shipped, and referenced by dashboards that different teams rely on. Nothing in the
repo's decision records, docs, or issues states which reading is canonical, and no ruling exists
either way.

## Your task

Record `active user` in the vocabulary register.
