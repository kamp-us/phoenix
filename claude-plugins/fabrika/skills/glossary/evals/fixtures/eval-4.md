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
$ fabrika glossary drift --register terms
drift
parcel state	7	src/courier/state.ts
courier dispatch	4	src/courier/dispatch.ts
retry budget	2	src/net/retry.ts
```

```
$ fabrika glossary lookup "parcel state" "courier dispatch" "retry budget" --register both
declared	terms	Delivery	parcel state
declared	terms	Delivery	courier dispatch
declared	terms	Core	retry budget
```

## Context

Nothing else changed in the register this week.

## Your task

Bring the vocabulary register up to date for this week's drift.
