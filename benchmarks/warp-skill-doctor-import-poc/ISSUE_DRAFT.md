# Draft tracking issue — skill-doctor production import (FILED as #8035)

Filed 2026-09-06: https://github.com/kamp-us/phoenix/issues/8035
(`gh issue create`, label `status:needs-triage`). This local file is the kept
source of the posted body; the extraction point was the `## Summary` heading to
EOF. Do not edit the body here expecting the issue to change — edit the issue.

Per the maintainer's direction (2026-08-31, the import-experiment session):
**one tracking issue with five blocker sections, not five noisy issues.** After review,
split only the sections maintainers agree to pursue.

Title (under ~70 chars):

```
skill-doctor fabrika import: five blockers before production
```

Labels: `status:needs-triage` (applied by the verb; nothing else — type/priority are triage's call)

---

## Summary

The Warp Skill Doctor (MIT, `warpdotdev/common-skills` @ `b811c243`, re-synced
2026-09-06 from the original `0254cbe9` import) imports into
fabrika byte-exact, its 25 upstream tests pass, and its unmodified pipeline ran
end-to-end over two real phoenix-local opencode sessions to a B+ report —
re-verified 2026-09-06 after the re-sync. Five
blockers stand between the PoC import (local, untracked, at
`claude-plugins/fabrika/skills/skill-doctor/`) and a production import. Full evidence:
`benchmarks/warp-skill-doctor-import-poc/REPORT.md` (also untracked, local).

## What I was doing

Running the local-only import experiment ratified in
[discussion #7319](https://github.com/kamp-us/phoenix/discussions/7319): upstream skill
imported byte-exact (git-blob-SHA verified), real upstream collector/rubrics/renderer run
against the only phoenix-local agent history on the machine (2 opencode sessions), every
output kept under `benchmarks/warp-skill-doctor-import-poc/results/`.

## What I observed

The pipeline works; five things block production. Each blocker is a section below, with
the evidence and the exact change.

### Blocker 1 — no opencode collector; startup gate excludes opencode

Upstream supports Warp / Claude Code / Codex only. Its own dry run found **0 phoenix
sessions** across those sources (`~/.claude/projects` empty; `~/.codex` holds 293
rollouts, 0 for this checkout; no Warp data). Upstream #93 (2026-09-03) added Pi,
Grok Build and ZCode collectors — narrowing this blocker — but opencode, the harness
this repo actually runs under, is still absent, and the only phoenix-local history
is opencode's SQLite store (`~/.local/share/opencode/opencode.db`: `session`/`message`/
`part` tables; part types `text`/`tool`/`patch`), which no upstream collector reads —
and upstream's Step-0 gate would refuse an opencode execution outright. The PoC
bridged this with a translation shim (`results/opencode_adapter.py`, outside the
imported skill) feeding upstream's `--claude-home`; that shim is a working reference
for the shape mapping, not a collector.

**Change:** add an opencode collector to the imported skill (or upstream: read
`opencode.db` read-only; map parts per the shim) and add `opencode` to
`references/supported-harnesses.md`'s startup gate + collector table with source
overrides. Without this, the skill cannot see phoenix's actual history — inert on arrival.

### Blocker 2 — Windows/UTF-8 portability bug in upstream scripts

Three `read_text()` calls in `test_render_report.py` omit `encoding="utf-8"`; on
Windows (cp1252 default) they crash on SKILL.md's UTF-8 smart quotes — 3/11 render tests
fail without `PYTHONUTF8=1`. `collect_sessions.py`'s reads carry the same latent
exposure. Also: SKILL.md's `mktemp -d "${TMPDIR:-/tmp}/..."` REPORT_DIR recipe is
POSIX-only, and `python3` does not resolve on this machine's Windows Python.

**Change:** add `encoding="utf-8"` to every file read in the scripts; replace the POSIX
mktemp recipe with a portable scratch-dir step; resolve the interpreter per-OS. Prefer
upstreaming the encoding fix; carry a local patch if upstream is slow.

### Blocker 3 — Warp branding and share-by-default report content

The rendered `report.html` embeds transcript-derived findings and diffs, ships a
"share as png" button, and carries Warp Factories footer/CTA branding. A fabrika-owned
report artifact that is shareable-by-default and advertises another vendor is both a
privacy hazard (the PoC's own findings quote real session content) and off-brand.

**Change:** decide the posture — strip the Warp Factories footer/CTA and the share-PNG
button, or keep with an explicit note in the skill body that `report.html` embeds
transcript-derived content, must never be committed unreviewed, and must live under an
ignored results dir. Record the decision either way.

### Blocker 4 — discovery misses fabrika's nonstandard skills path

Upstream discovers project skills only under `.agents/skills`, `.claude/skills`,
`.codex/skills`. Fabrika's skills live at `claude-plugins/fabrika/skills` (wired via
`opencode.json`), so the caller must pass `--skills-dir` on every invocation or the run
grades zero skills. This repo also has a *different* `.claude/skills` (ctx-* skills) that
upstream would auto-discover and misattribute.

**Change:** encode the skills path in the skill body / config (the conventions' §4
plain-literal rule) or extend the collector's default roots for this repo; ensure the
ctx-* skills under `.claude/skills` cannot be misattributed as fabrika's.

### Blocker 5 — fabrika conventions not yet met

The imported skill is upstream-shaped: no `contract.md`, no routing-thin SKILL.md, no
`fabrika` verb wiring, English body where fabrika skills follow the writing-for-agents
discipline, and the two upstream unittest suites are not wired into any validation path.
RE-SYNC RISK: because the files are byte-exact upstream, local edits drift silently from
upstream — the provenance note's "re-copy, never edit in place" rule must survive the
fabrika-ization.

**Change:** split per `claude-plugins/fabrika/docs/skill-conventions.md` — SKILL.md as
routing surface, a new `contract.md` carrying collector flags / scoring contract /
edit-drafting gate, keeping upstream's rubrics/scorers byte-exact; wire the upstream
unittests into the import PR's checks; keep `PROVENANCE.md`'s re-sync rule binding.

## Why it matters

The verdict from the experiment is **revise before import** (REPORT.md §11): the import
is license-clean and mechanically sound, but landing it as-is installs a skill that
cannot run its own Step 0 → Step 1 on this repo's harness, fails 3 tests on Windows,
ships shareable-by-default transcript-derived output, misses the skills corpus it is
supposed to grade, and violates fabrika's own skill conventions. The blockers are
ordered: 1 (collector) is the one that makes the skill functional here at all.

After the blockers, rerun on **at least 20 real sessions** before trusting any grade —
the PoC's B+ over 2 sessions (one being the experiment itself) is evidence the pipeline
runs, not a measurement of the corpus.

## Pointers

- PoC experiment (untracked, local): `benchmarks/warp-skill-doctor-import-poc/` —
  `REPORT.md` (full evidence, scores, verdict), `ADAPTATION.md` (deviation ledger),
  `results/` (inventory, transcripts, upstream-rendered `report.html`,
  `opencode_adapter.py` shim)
- Import candidate (untracked, local): `claude-plugins/fabrika/skills/skill-doctor/`
  (12 byte-exact upstream files @ `b811c243`, re-synced 2026-09-06 + `LICENSE` +
  `PROVENANCE.md`)
- Upstream: https://github.com/warpdotdev/common-skills/tree/main/.agents/skills/skill-doctor
- Discussion: https://github.com/kamp-us/phoenix/discussions/7319
- Conventions: `claude-plugins/fabrika/docs/skill-conventions.md`

## Suggested next step (non-binding)

My guess: maintainers review the five sections, keep 1 (opencode collector), 2 (UTF-8),
and 4 (skills path) as the functional minimum, rule on 3 (branding posture) explicitly,
and treat 5 (fabrika-ization) as the packaging step that lands with the import PR. Split
into per-blocker issues only the ones agreed for pursuit; this tracking issue stays open
until each is either split or closed by decision.

## Machine-local paths note

Every path in the Pointers section above is repo-relative and safe to post. The
underlying PoC files contain machine-local evidence (absolute paths in transcripts,
`~`-rooted storage paths) and must not be attached to the issue — the report verb's leak
guards red on them; if excerpts are ever needed, quote them under `--redact`.
