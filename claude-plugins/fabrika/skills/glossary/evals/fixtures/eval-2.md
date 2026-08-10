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
$ fabrika glossary drift --register both
drift
seam boundary	5	docs/architecture/layering.md
courier	3	src/courier/dispatch.ts
```

```
$ fabrika glossary lookup "seam boundary" "courier" --register both
absent	-	-	-
absent	-	-	-
```

```
$ fabrika glossary sections --register terms
terms	Core	6
terms	Products	9
terms	Delivery	3
```

## Context

Two names were coined this week.

**`seam boundary`** appears in `docs/architecture/layering.md`. It names the general structural
idea of the line across which two layers agree on an interface — the doc uses it to describe any
layered system, not a specific module of this codebase.

**`courier`** is `src/courier/dispatch.ts`: the concrete service in this product that hands a
parcel to a delivery partner and tracks it. It is a thing this repo has.

## Your task

Record both coinages in the vocabulary registers.
