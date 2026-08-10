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

You are working in **`veridian/harbor`**, a product repository. It is not phoenix and shares nothing
with it. Its highest issue number is **#9127**.

## What Dilek asked for, in `#9127`

> Can someone chart the invite acceptance form? We keep talking about it and never getting to it.
> It needs to take the token from the emailed link, show the newcomer who sponsored them, and let
> them pick a handle. Behind a feature flag until we're happy with it.

## Board excerpt — open issues in `veridian/harbor`

| # | State | Type | Title |
|---|---|---|---|
| 9104 | open | feature | Invite tokens are single-use and expire in 72h |
| 9111 | closed | decision | Handles are immutable once chosen |
| 9119 | open | chore | Move the auth callback off the legacy route |
| 9126 | open | feature | Rate-limit the invite redemption endpoint |

There is no open issue carrying `wayfinding:map`. The `wayfinding:map` and `status:needs-triage`
labels both exist in the repository.

## Your task

Dilek is asking for a wayfinding session on this. Do the right thing with it. Carry it to the point
where there is nothing further this session should do, then end on exactly one terminal and write
the four files.
