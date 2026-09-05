---
name: skill-doctor
description: "Grade the local agent setup's installed skills by scoring recent agent conversations against efficiency and code-quality rubrics, then draft skill edits and render one HTML report. Human-typed only; the model cannot fire this."
disable-model-invocation: true
---

# skill-doctor

Grade an agent setup from its real conversation history: collect recent local agent sessions,
score each against two rubrics, measure how much the installed skills were actually used,
aggregate to one grade, and render one self-contained HTML report with proposed skill edits.

Vendored from [Warp Skill Doctor](https://github.com/warpdotdev/common-skills/tree/main/.agents/skills/skill-doctor)
(MIT). Which files are upstream's and which are fabrika's — and the re-copy, never edit rule —
lives in [`PROVENANCE.md`](PROVENANCE.md).

**Inert on arrival, by design.** Two things this skill needs are later children of
[#8035](https://github.com/kamp-us/phoenix/issues/8035), and until they land a run on phoenix
produces a report over zero sessions:

- The upstream collectors read Claude Code, Codex, Warp (plus Pi, Grok Build, ZCode) — not
  opencode, the harness phoenix runs under. The opencode collector is
  [#8049](https://github.com/kamp-us/phoenix/issues/8049); until it lands, `--harness claude`
  sees only what a Claude-Code-shaped home contains.
- Skill discovery defaults to `.agents/skills`, `.claude/skills`, `.codex/skills`; fabrika's
  corpus lives at `claude-plugins/fabrika/skills`, so every invocation below passes
  `--skills-dir` explicitly until [#8051](https://github.com/kamp-us/phoenix/issues/8051)
  makes that the default.

## 1 — Collect sessions into the results directory

Everything this skill produces stays under one literal directory, which is gitignored. Create
it, then run the upstream collector with its flags — the flag table is contract section
**Collector flags**
(`fabrika wire doc-section --heading "Collector flags" < claude-plugins/fabrika/skills/skill-doctor/contract.md`):

```bash
mkdir -p claude-plugins/fabrika/skills/skill-doctor/results/claude-home
python claude-plugins/fabrika/skills/skill-doctor/scripts/collect_sessions.py --harness claude --claude-home claude-plugins/fabrika/skills/skill-doctor/results/claude-home --repo . --skills-dir claude-plugins/fabrika/skills --out claude-plugins/fabrika/skills/skill-doctor/results/run --days 45 --max-sessions 20
```

**Done when** the collector prints `sessions sampled` and
`claude-plugins/fabrika/skills/skill-doctor/results/run/inventory.json` exists. A run that
samples zero sessions on phoenix is the expected inert state above, not a failure — say so and
stop.

## 2 — Score every sampled session against both rubrics

The judgment is the whole step, and the rubrics are judgment-shaped reads: read
[`scorers/efficiency.md`](scorers/efficiency.md) and
[`scorers/code-quality.md`](scorers/code-quality.md) whole, then read each condensed transcript
under `claude-plugins/fabrika/skills/skill-doctor/results/run/transcripts/` and give it one
efficiency label and one code-quality verdict, each with the reason the rubric asks for. The
labels, their scores, the aggregation formulas, and the failed-conversation rule are contract
section **Scoring contract**
(`fabrika wire doc-section --heading "Scoring contract" < claude-plugins/fabrika/skills/skill-doctor/contract.md`).

**Done when** every sampled session carries two labels with reasons, and the aggregate
efficiency, code quality, skill coverage, and overall numbers are computed.

## 3 — Write the report JSON and render it

Write `claude-plugins/fabrika/skills/skill-doctor/results/run/report.json` in the schema of
contract section **Report artifacts**
(`fabrika wire doc-section --heading "Report artifacts" < claude-plugins/fabrika/skills/skill-doctor/contract.md`),
then render:

```bash
python claude-plugins/fabrika/skills/skill-doctor/scripts/render_report.py claude-plugins/fabrika/skills/skill-doctor/results/run/report.json
```

**Done when** the renderer prints the `report.html` path and the grade it contains.

## Report boundary

Everything under `claude-plugins/fabrika/skills/skill-doctor/results/` is gitignored and stays
local: transcripts, inventories, `report.json`, and `report.html` all embed transcript-derived
content and machine-local paths. **Never commit, attach, or paste them**; the report's finding
text is the only thing that may be quoted, redacted, in a decision or issue that needs it. The
rendered report currently carries upstream's branding and share affordances — it is
internal-only until [#8052](https://github.com/kamp-us/phoenix/issues/8052) re-brands it and
[#8054](https://github.com/kamp-us/phoenix/issues/8054) rules its share posture.

## Terminal vocabulary

- `REPORTED` — the renderer exited `0` and the grade is on screen. The report stays internal
  per the boundary above.
- `NO-SESSIONS` — the collector sampled zero sessions. Expected on phoenix until #8049; a
  correct stopping point, not a failure. Name the harness you ran and the window you gave it.
- `COLLECTOR-REFUSED` — the collector exited non-zero naming its inputs. Fix the named input
  and run it again; a non-zero exit is unknown, never "nothing collected".
