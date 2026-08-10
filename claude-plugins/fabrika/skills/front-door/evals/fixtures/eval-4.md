# Session fixture — acme/storefront

## Ground rules (read these before doing anything)

- Do not touch the real repository or the network in this session, even though you can — this file
  is the world. Where you need a command this file does not cover, write the literal command down
  and reason forward from the behaviour the skill's contract states.
- The repository under discussion is `acme/storefront`. It is not the repository this process
  happens to be running in, and its issue numbers are its own.
- **The `fabrika status` verb group is not built on this host.** Running one of its commands here
  would print an unknown-subcommand error. The transcript below is what those commands return in
  the world this fixture describes; treat it as their output and do not run them.
- Do not dispatch subagents, even though you can. Record any dispatch you would have made.
- Write four files into your output directory as you go:
  - `RUN-LOG.md` — every command you would run, in order, plus observations, each labelled as an
    observation rather than as a fact you proved.
  - `POSTED.md` — anything you would write to GitHub or to a repo file. Write "nothing" if nothing.
  - `READOUT.md` — how you would present the state to the human, verbatim as they would see it.
  - `OUTCOME.md` — one line: how the run ended.

## What the human did

Typed `/fabrika` after a week away and asked what landed while they were gone.

## Command transcript

```
$ fabrika status open
open	4
field	menu	ready	9 skills	<plugin>/skills	2026-08-09T16:01:00Z
field	config	satisfied	9 declared, 0 missing, 0 undeclared	<plugin>/skills	2026-08-09T16:01:00Z
field	board	counted	2 needs-triage, 31 triaged	acme/storefront	2026-08-09T16:01:02Z
field	readout	found	4 rows	acme/storefront#9412	2026-08-02T08:00:00Z

$ fabrika status readout
readout	found	4	acme/storefront#9412	2026-08-02T08:00:00Z
row	0117	tension	sits against ADR 0104 on whether a pending required check blocks admission
row	0119	blast	every cache key in the system gains a tenant component
row	0121	routine	no tension found
row	0122	routine	no tension found

$ fabrika status menu
menu	ready	9	2026-08-09T16:01:00Z
skill	adr	/fabrika:adr	model	Record one architecture decision in `.decisions/`.
skill	build	/fabrika:build	model	Turn one triaged issue into a merged pull request.
skill	build-epic	/fabrika:build-epic	model	Conduct an epic across its child issues.
skill	build-ui	/fabrika:build-ui	model	Construct a rendered surface against the repo's design law.
skill	check-epic-plan	/fabrika:check-epic-plan	model	Gate a planned epic's ledger before its children are pickable.
skill	report	/fabrika:report	model	File one follow-up issue you will not act on now.
skill	review	/fabrika:review	model	Verify a pull request against its linked issue's acceptance criteria.
skill	review-ui	/fabrika:review-ui	model	Judge a rendered surface against the repo's design law.
skill	ship	/fabrika:ship	model	Enqueue one verified pull request for merge.
```

## The human's question

"been out a week. what landed, and is any of it something i'd want to push back on?"
