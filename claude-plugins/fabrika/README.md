# fabrika

> Copy from the already-battle-tested external workflow (mattpocock/skills — the skill theory,
> surveyed with receipts on #4644) and from our own already-battle-tested one (the pipeline's
> verbs, gates, and 74-incident scar tissue) — and **build fabrika for the next generation of
> software building with agents.** Neither source arrives on authority: every borrowed idea
> re-earns its place against the eval bar.
>
> — the founder mission statement, recorded on epic [#4648](https://github.com/kamp-us/phoenix/issues/4648)

**fabrika** is the kamp.us agent pipeline, rebuilt from first principles as its own plugin. It
grew beside the v1 baseline (`claude-plugins/kampus-pipeline/`), a deliberate experiment that
succeeded at its own goal and ran its course (wayfinder:map #4631); that tree was kept frozen as
the measuring stick while fabrika earned its place, then retired and deleted once fabrika became
the one pipeline (ADR 0291, #5937).

Turkish for "factory". The name is sealed (#4631) and styled lowercase, like the sibling brand
nouns `sozluk` and `pano`.

## The route in: writing-for-agents

**Every skill in `skills/` is written under
[`writing-for-agents`](skills/writing-for-agents/SKILL.md), against the [fabrika skill
conventions](docs/skill-conventions.md)** — founder ruling of 2026-08-18, recorded on
[#5945](https://github.com/kamp-us/phoenix/issues/5945) and carried by
[#5953](https://github.com/kamp-us/phoenix/issues/5953). It is one route for three cases that used
to be graded differently: a new skill, an edit to a skill already here, and a port of a v1 skill.
fabrika still builds no authoring tool of its own ([#4648 scope
correction](https://github.com/kamp-us/phoenix/issues/4648#issuecomment-5152523719)); what fabrika
owns here is the discipline.

That ruling retires the earlier posture, which made a `/skill-creator` session the only door and
named a port a defect by construction ([#4637-C](https://github.com/kamp-us/phoenix/issues/4637)).
A port that meets the discipline now enters the same way anything else does, so no skill needs a
per-PR ruling to get through the gate.

What did not change: nothing is dropped into `skills/` unread. The text still has to pass the
conventions, and it is the text that is graded rather than the session that produced it.

## Layout

```
claude-plugins/fabrika/
├── .claude-plugin/plugin.json   the plugin manifest (no version — ADR 0110, continuous ship)
├── README.md                    this file: the mission, the route in, the layout
├── agents/                      builder, reviewer, shipper, operator (see docs/agent-shells.md)
├── docs/                        the canonical convention + contract docs (see docs/README.md)
└── skills/                      one dir per skill, each written under writing-for-agents
```

`agents/` holds exactly four **agent shells** — `builder`, `reviewer`, `shipper`, `operator` —
behaviour-free spawn targets that each preload one skill. The shell names the actor and never the
skill it loads, so the `builder` shell runs the `build` skill — and the shell is addressed by that
bare name, not by `fabrika:builder`. What a shell may hold, why there are four, why its name is
a noun, and why a shell that grows opinions is a defect are all in
[docs/agent-shells.md](docs/agent-shells.md).

`skills/` carries no `README` and no loose files: the fabrika layout law is `SKILL.md` under a
per-skill directory and nothing else at the `skills/` root. A `.gitkeep` remains from when the
directory was empty; it is harmless and can go with any later change.

## Install

fabrika ships through the `kampus` marketplace, and phoenix consumes it from that same
marketplace entry — the ship channel is the dogfood channel ([#4670](https://github.com/kamp-us/phoenix/issues/4670)).

```
/plugin marketplace update kampus
/plugin install fabrika@kampus
```

**Refresh first.** The install reads a locally cached catalog. A cache that predates fabrika's
entry refuses by name — `Plugin "fabrika" not found in marketplace "kampus"` — instead of saying
it is out of date, and the same message comes back when the marketplace was never registered on
the machine at all, so the refusal does not tell you which of the two you hit. Updating first
clears the common one.

Inside phoenix you type neither line: `.claude/settings.json` declares the marketplace under
`extraKnownMarketplaces.kampus` and enables `fabrika@kampus`. A fresh clone picks both up once the
workspace is trusted — settings-declared marketplaces are read from project settings only after
you accept the trust prompt — so no collaborator needs a registration of their own.

## What is deliberately absent

- **No dependency on v1.** fabrika calls `pipeline-cli` nowhere — not from a skill, not from a verb.
  Its own verbs live in `packages/fabrika-cli/`. v1 is a reference to read, never a runtime to call,
  because a fabrika that calls the old tree can never be the thing that replaces it.

  The rule is **re-implement calls, pin formats** (ADR
  [0251](../../.decisions/0251-shared-formats-are-pinned-not-reimplemented.md)). Where fabrika and
  another program must agree on the same bytes on a GitHub artifact, neither side can re-implement
  its way out: fabrika owns that wire format and commits its canonical bytes as a golden fixture, and
  the other side conforms by pinning the fixture in a test of its own. Nothing about that is a call,
  and it points the dependency at fabrika rather than away from it. Tests follow the same line — a
  test asserting a fabrika property lives in `packages/fabrika-cli/`.
