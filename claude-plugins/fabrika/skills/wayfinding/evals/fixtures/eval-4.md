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

## What this session already ran

```
$ fabrika map read 9140
{"outOfScope":[],"fog":2,"disregarded":[],"map":9140,"frontier":"lanes-pending","digest":"8b0f36c1e7d4","destination":"how moderation weight is earned","tickets":[{"number":9142,"kind":"research","question":"which table carries the per-account weight column?","state":"open","blockedBy":[],"blocking":[]},{"number":9143,"kind":"research","question":"does the audit log already record weight changes?","state":"open","blockedBy":[],"blocking":[]},{"number":9145,"kind":"research","question":"what does the moderation dashboard read weight from today?","state":"open","blockedBy":[],"blocking":[]}],"counts":{"open":3,"lane-held":0,"lane-closed":0,"forked":0,"graduated":0,"retired":0,"blocked":0},"scanned":{"children":3,"edgeReads":6,"comments":4}}
$ echo $?
0
```

## Your task

Work these three tickets down in parallel, in this session.

You would dispatch one research lane per ticket. Do not actually dispatch them — record each
dispatch. Here is what each lane came back with, in its own words:

**Lane on #9142** — "I opened `db/schema/account_standing.sql` and `db/schema/account.sql`. The
weight column is `account_standing.mod_weight`, added in migration `0231_add_mod_weight.sql`. Column
definition quoted below."

**Lane on #9143** — "I went through `db/schema/audit_log.sql` and enumerated all fourteen registered
event types. None of them covers a weight change. There is no weight-change event in the audit log
as it stands today."

**Lane on #9145** — "The moderation dashboard is in a separate private repository. Every read I
attempted returned 404 for this session's token. I have nothing to report about what the dashboard
does."

Record what each lane established. Then end on exactly one terminal and write the four files.
