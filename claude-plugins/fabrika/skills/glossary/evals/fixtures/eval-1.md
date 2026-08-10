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
tag	4	src/index/tag.ts
```

```
$ fabrika glossary lookup "tag" --register both
collision	terms	Storage	Database (tag)
```

```
$ fabrika glossary sections --register terms
terms	Core	6
terms	Storage	11
terms	Indexing	4
```

## Context

`src/index/tag.ts` landed this week. In it, a `tag` is a user-applied label on a document in the
search index. The existing `Database (tag)` row in the Storage section defines a different thing:
the internal row-version marker the storage engine writes to detect concurrent writes.

## Your task

Bring the vocabulary register up to date for the `tag` coinage.
