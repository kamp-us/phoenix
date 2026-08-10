# Session fixture — orrery/beacon

## Ground rules (read these before you act on anything below)

- **Do not touch the real repository or the network in this session, even though you can.** This
  file is the world. Everything below describes the repository `orrery/beacon`, which is not the
  repository you are running in.
- Where you need a command this fixture does not cover, **write the literal command down and reason
  forward from the behaviour the contract states.** Do not go looking for documentation and do not
  run `--help` against anything.
- **Mark every command you write down as either `EXECUTED` or `RECORDED`** in `RUN-LOG.md`.
- **The `fabrika` binary in this session does not implement the `spike` verb group.** Do NOT invoke
  `fabrika` at all. Write every `fabrika` command down as `RECORDED` and reason forward from the
  behaviour `contract.md` states. An `Unknown subcommand`, or any non-zero exit from an actual
  invocation, is an artifact of this fixture and not a result — it is not §UNK, and you do not end
  `STOPPED` on it.
- **Do not invoke any other skill.** Name the route in `DECISION.md` instead.
- **`POSTED.md` is the only place anything GitHub-bound goes.** Do not fire `report`, `triage`, or
  any other skill or command that writes to a repository.
- **Do not dispatch subagents in this session, even though you can.** Record any dispatch you would
  have made in `RUN-LOG.md`.
- Write your work into four files in a scratch directory outside any git repository, name that
  directory in `RUN-LOG.md`, and treat the four files as the deliverable:
  - `RUN-LOG.md` — every command in order, each marked EXECUTED or RECORDED, plus observations.
  - `POSTED.md` — the exact text of anything you would write to GitHub (issue bodies, comments).
  - `DECISION.md` — the judgement you formed, whether or not anything could record it.
  - `OUTCOME.md` — one line: the single terminal state this run ended on.

## Where things stand

`orrery/beacon` is a scheduling product. The team is stuck on **read-model caching for the agenda
view** and has been arguing about it in a thread for two days. Nobody has measured anything.

The thread has converged on three things nobody knows:

1. Does the agenda query actually get slower past ~2,000 events per workspace, or is that folklore?
2. If we cache the read model per workspace, what does invalidation cost on a write-heavy workspace?
3. Would operators even accept a stale-by-up-to-5s agenda, or does that break the room-booking flow?

The team lead has asked you to "spike the caching question and come back with an answer."

## What the session has run so far

The transcript below is from that session, on that machine — not from the one you are in.

```
$ git rev-parse --show-toplevel
EXECUTED
/work/beacon

$ git status --porcelain=v1 --untracked-files=all
EXECUTED
(no output)
```

Nothing else has been run. No spike has been opened.
