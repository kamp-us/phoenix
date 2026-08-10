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

Typed `/fabrika`, then asked whether the repo is ready for the pipeline to run unattended.

## Command transcript

```
$ fabrika status open
open	4
field	menu	ready	12 skills	<plugin>/skills	2026-08-09T11:40:02Z
field	config	gaps	9 declared, 0 missing, 3 undeclared	<plugin>/skills	2026-08-09T11:40:02Z
field	board	counted	0 needs-triage, 0 triaged	acme/storefront	2026-08-09T11:40:04Z
field	readout	found	2 rows	acme/storefront#9412	2026-08-08T22:10:00Z

$ fabrika status config
config	gaps	9	0	3	0
surface	build	-	bootstrap	present	build pick prints an empty pool and the run ends BACKED-OFF	labels present	2026-08-09T11:40:04Z
surface	build	-	degrade	present	an absent file and an empty section are the same well-formed default	ROADMAP.md	2026-08-09T11:40:02Z
surface	build-ui	-	fail-loud	present	exit 12 ends the session at BLOCKED-NO-MANIFEST with no branch cut	design-system-manifest.md	2026-08-09T11:40:02Z
surface	review	-	fail-loud	present	review criteria refuses to grade without it	the linked issue's ### Acceptance criteria block	2026-08-09T11:40:02Z
surface	ship	-	fail-loud	unprobeable	an unverifiable merge path is never assumed green	declared subject is a merge queue on the base branch	2026-08-09T11:40:02Z
surface	adr	-	undeclared	unknown	-	no `## Required repo files` section	2026-08-09T11:40:02Z
surface	report	-	undeclared	unknown	-	no `## Required repo files` section	2026-08-09T11:40:02Z
surface	triage	-	undeclared	unknown	-	no `## Required repo files` section	2026-08-09T11:40:02Z
```

## The human's question

"config says zero missing and the board's empty. are we good to let it run on its own?"
