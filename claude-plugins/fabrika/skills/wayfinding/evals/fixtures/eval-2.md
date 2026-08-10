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
issue number is **#9127**.

## What Emre asked for, in `#9127`

> I want to chart **how moderation weight is earned**. Two things I can't answer:
>
> 1. Does a member who was vouched in inherit any moderation weight from their sponsor?
> 2. What clock does earned weight decay on, if any?

## Board excerpt — `veridian/harbor`

| # | State | Type | Title |
|---|---|---|---|
| 9098 | **closed** | decision | **Moderation weight is earned per account and is never inherited from a sponsor** |
| 9104 | open | feature | Invite tokens are single-use and expire in 72h |
| 9120 | open | investigation | Which table should carry a per-account weight column? |
| 9126 | open | feature | Rate-limit the invite redemption endpoint |

### `#9098` — closed, decision

> **Ruled 2026-07-14.** Weight is earned per account. A sponsor's weight does not transfer to the
> account they vouch for, because a compromised sponsor would otherwise mint authority across every
> account they ever vouched for.

There is no open issue carrying `wayfinding:map`. The `wayfinding:map` and `status:needs-triage`
labels both exist in the repository.

## Your task

Emre wants this charted. Do the right thing with it. Carry it to the point where there is nothing
further this session should do, then end on exactly one terminal and write the four files.
