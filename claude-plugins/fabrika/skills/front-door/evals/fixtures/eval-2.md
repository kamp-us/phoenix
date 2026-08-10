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

Installed fabrika into `acme/storefront` — a small Next.js marketing site — yesterday, and typed
`/fabrika` for the first time.

## Command transcript

```
$ fabrika status open
open	4
field	menu	ready	9 skills	<plugin>/skills	2026-08-09T09:04:11Z
field	config	gaps	9 declared, 2 missing, 0 undeclared	<plugin>/skills	2026-08-09T09:04:11Z
field	board	counted	0 needs-triage, 0 triaged	acme/storefront	2026-08-09T09:04:13Z
field	readout	absent	no readout artifact	acme/storefront	unknown

$ fabrika status config
config	gaps	9	2	0	0
surface	build	-	bootstrap	missing	build pick prints an empty pool and the run ends BACKED-OFF	no label status:triaged in acme/storefront	2026-08-09T09:04:13Z
surface	build	-	degrade	present	an absent file and an empty section are the same well-formed default	ROADMAP.md	2026-08-09T09:04:11Z
surface	build	-	fail-loud	unprobeable	a validator that cannot be executed is exit 11, UNKNOWN, never green	declared subject is a package.json script pair, not a path or a label	2026-08-09T09:04:11Z
surface	build-ui	-	fail-loud	missing	exit 12 ends the session at BLOCKED-NO-MANIFEST with no branch cut	no design-system-manifest.md at repo root	2026-08-09T09:04:11Z
surface	review	-	fail-loud	present	review criteria refuses to grade without it	the linked issue's ### Acceptance criteria block	2026-08-09T09:04:11Z
surface	ship	-	fail-loud	unprobeable	an unverifiable merge path is never assumed green	declared subject is a merge queue on the base branch	2026-08-09T09:04:11Z
```

## What is already in the repo, if you go looking

`app/globals.css`:

```css
:root {
  --brand-600: #1f5fd6;
  --accent-teal: #0aa3a3;
  --ink-900: #10151f;
  --surface-0: #ffffff;
  --radius-card: 10px;
}
.btn-primary { background: var(--brand-600); border-radius: var(--radius-card); }
.badge-sale  { background: #2f7ae5; }
.link-inline { color: #1a6fe0; text-decoration: underline; }
```

`app/layout.tsx` sets one webfont, `Söhne`, with `system-ui` as the fallback.
There is no design documentation anywhere in the repository.

## Later in the same session

Assume the human answers whatever you ask them, and that any `fabrika status bootstrap` you run
returns a line of the form `bootstrap	created	<surface-id>	<target>	ok`.

## The human's question

"first time running this. what do i need to set up?"
