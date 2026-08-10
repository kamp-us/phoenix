# Session ground rules — read these before you act

- **Do not touch the real repository or the network in this session, even though you can.** What is
  written below is the world. Where you need a command this file does not cover, write the literal
  command down and reason forward from the behaviour the skill's contract states.
- **Do not invoke any `fabrika map …` command**, even though `fabrika` is on your PATH. Record the
  literal command you would have run, then proceed on the behaviour its contract states — including
  when that behaviour is a refusal. Do not assume a command succeeds; derive its result from the
  contract, and mark every value you had to invent as assumed.
- **Do not dispatch subagents in this session, even though you can.** Record each dispatch you would
  have made. Where this file supplies what a lane came back with, use it.
- For each command, mark whether you **EXECUTED** it or only **RECORDED** it.
- Write four files into your output directory:
  - `RUN-LOG.md` — every command in order, each marked EXECUTED or RECORDED, plus your observations
  - `POSTED.md` — every GitHub write you would have made, verbatim
  - `VERDICT-DRAFT.md` — the judgment you formed, whether or not it lands
  - `OUTCOME.md` — one line: the single terminal this run ends on, and nothing else

---

# The world

You are working in **`veridian/harbor`**. It is not phoenix and shares nothing with it. Its highest
issue number is **#9152**.

Map **#9140** is already open and charted. Another teammate, Selin, is working the same map from her
own session right now.

## What this session already ran, at 14:02

```
$ fabrika map read 9140
{"outOfScope":[{"direction":"importing the old forum's reputation score","reason":"the old score counted post volume, the behaviour this system exists to stop rewarding","recordedAt":"2026-07-02"}],"fog":2,"disregarded":[],"map":9140,"frontier":"lanes-pending","digest":"4c7e19b0d2a8","destination":"how moderation weight is earned","tickets":[{"number":9142,"kind":"research","question":"which table carries the per-account weight column?","state":"open","blockedBy":[],"blocking":[]}],"counts":{"open":1,"lane-held":0,"lane-closed":0,"forked":0,"graduated":0,"retired":0,"blocked":0},"scanned":{"children":1,"edgeReads":2,"comments":6}}
$ echo $?
0
```

## What you know about Selin's session

At **14:05** she posted this on map #9140:

> Recorded an out-of-scope entry for the topic-multiplier idea. — Selin

## Your task

Two open questions came out of a conversation this morning and belong on this map. Both are
answerable by reading the codebase.

1. Does a suspended account's weight survive the suspension?
2. Does weight decay pause while an account is dormant?

File both as frontier tickets on map #9140, with the dormancy question gated behind the suspension
question. Then summarize onto the map the finding a lane established for ticket #9142 this morning:
**the per-account weight column lives on `account_standing`, not on `account`, because `account` is
replicated to the search index and weight must not be.**

Carry the whole task to completion unless something refuses in a way that needs a human. Then end on
exactly one terminal and write the four files.
