# fabrika

> Copy from the already-battle-tested external workflow (mattpocock/skills — the skill theory,
> surveyed with receipts on #4644) and from our own already-battle-tested one (the pipeline's
> verbs, gates, and 74-incident scar tissue) — and **build fabrika for the next generation of
> software building with agents.** Neither source arrives on authority: every borrowed idea
> re-earns its place against the eval bar.
>
> — the founder mission statement, recorded on epic [#4648](https://github.com/kamp-us/phoenix/issues/4648)

**fabrika** is the kamp.us agent pipeline, rebuilt from first principles as its own plugin. It
grows here, beside the v1 baseline in [`../kampus-pipeline/`](../kampus-pipeline/), which stays
frozen and untouched — v1 is not a failure to clean up but a deliberate experiment that succeeded
at its own goal and has run its course (wayfinder:map #4631). Keeping it intact is what gives
fabrika something to be measured against.

Turkish for "factory". The name is sealed (#4631) and styled lowercase, like the sibling brand
nouns `sozluk` and `pano`.

## The only door: /skill-creator

`/skill-creator` is the founder's **existing** skill, used **as-is** — fabrika builds no
authoring tool of its own ([#4648 scope
correction](https://github.com/kamp-us/phoenix/issues/4648#issuecomment-5152523719)). What
fabrika owns here is the discipline, not the tool.

**No skill enters fabrika by any path other than `/skill-creator`** — founder ruling
[#4637-C](https://github.com/kamp-us/phoenix/issues/4637). There is no second door: a skill is
not hand-dropped into `skills/`, not ported from v1, not copied from a sibling plugin. Every
fabrika skill is authored through `/skill-creator`, against the [fabrika skill
conventions](docs/skill-conventions.md), and enters as that session's output.

This posture is why `skills/` fills one authoring session at a time rather than by porting. A skill
that appears here by any other route is a defect, not a shortcut — the door is the only door.

## Layout

```
claude-plugins/fabrika/
├── .claude-plugin/plugin.json   the plugin manifest (no version — ADR 0110, continuous ship)
├── README.md                    this file: the mission, the only-door posture, the layout
├── docs/                        the canonical convention + contract docs (see docs/README.md)
└── skills/                      one dir per skill, each authored by /skill-creator
```

`skills/` carries no `README` and no loose files: the fabrika layout law is `SKILL.md` under a
per-skill directory and nothing else at the `skills/` root. A `.gitkeep` remains from when the
directory was empty; it is harmless and can go with any later change.

## What is deliberately absent

- **No marketplace entry.** fabrika is not listed in the root marketplace manifest
  (`.claude-plugin/`), so nothing here reaches the pinned external channel (#4643).
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
