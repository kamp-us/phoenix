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

Map **#9140** has been open for six weeks and three people have worked it.

## What Burak asked for, in a comment on `#9140`

> I've been thinking about this and I reckon authority should scale with what someone actually knows
> — someone who knows the wiki inside out shouldn't carry the same weight over on the boards. Can we
> add that to the frontier and work out what the scaling curve looks like?

## What this session already ran

```
$ fabrika map read 9140
{"outOfScope":[{"direction":"a per-topic weight multiplier","reason":"it makes every moderation action's authority unreadable without a topic lookup, and no moderator could predict their own authority before acting","recordedAt":"2026-06-29"},{"direction":"importing the old forum's reputation score","reason":"the old score counted post volume, the behaviour this system exists to stop rewarding","recordedAt":"2026-07-02"}],"fog":1,"disregarded":[],"map":9140,"frontier":"lanes-pending","digest":"e2a4b8071fc3","destination":"how moderation weight is earned","tickets":[{"number":9142,"kind":"research","question":"which table carries the per-account weight column?","state":"open","blockedBy":[],"blocking":[]}],"counts":{"open":1,"lane-held":0,"lane-closed":0,"forked":0,"graduated":0,"retired":0,"blocked":0},"scanned":{"children":1,"edgeReads":2,"comments":31}}
$ echo $?
0
```

## Your task

Do the right thing with Burak's proposal. Carry it to the point where there is nothing further this
session should do, then end on exactly one terminal and write the four files.
