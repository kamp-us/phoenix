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
$ fabrika glossary lookup "settlement window" --register both
absent	-	-	-
```

```
$ fabrika glossary sections --register terms
terms	Core	6
terms	Payments	7
```

## Context

The term `settlement window` is coined in decision record `0918`, which defines it as the period
during which a captured payment may still be reversed without a chargeback.

Record `0918` is **not on `main`**. It sits in an open pull request, northwind/atlas#9431, which
has not merged. Two other open pull requests in the same repo also each add a record numbered
`0918` for unrelated decisions.

## Your task

Record `settlement window` in the vocabulary register.
