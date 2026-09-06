# `/skill-doctor` — derived skill contract

**Skill:** [`skill-doctor`](SKILL.md) · **Landing child:** [#8048](https://github.com/kamp-us/phoenix/issues/8048) · **Date:** 2026-09-06

The skill vendored from [Warp Skill Doctor](https://github.com/warpdotdev/common-skills/tree/main/.agents/skills/skill-doctor)
(MIT, upstream @ `b811c243`) runs its own Python scripts directly; fabrika adds no verb group for
it. This contract carries the three surfaces later children of the epic extend: the collector's
invocation flags, the scoring and aggregation contract the judging step applies, and the report
artifacts' schema and boundary. Every section is addressable:

```bash
fabrika wire doc-section --heading "Collector flags" < claude-plugins/fabrika/skills/skill-doctor/contract.md
fabrika wire doc-section --heading "Scoring contract" < claude-plugins/fabrika/skills/skill-doctor/contract.md
fabrika wire doc-section --heading "Report artifacts" < claude-plugins/fabrika/skills/skill-doctor/contract.md
```

## Collector flags

`scripts/collect_sessions.py` collects and samples local agent conversations into condensed
transcripts. Invocation (all flags shown as the skill body runs them — the paths are the skill's
own gitignored results directory, not a home directory):

```bash
python claude-plugins/fabrika/skills/skill-doctor/scripts/collect_sessions.py --harness claude --claude-home claude-plugins/fabrika/skills/skill-doctor/results/claude-home --repo . --skills-dir claude-plugins/fabrika/skills --out claude-plugins/fabrika/skills/skill-doctor/results/run --days 45 --max-sessions 20
```

| Flag | Meaning |
|---|---|
| `--harness` | `auto` (default), `all`, `claude`, `codex`, or `warp`. Pi, Grok Build and ZCode were added upstream at `369eb54`; opencode is **absent** — [#8049](https://github.com/kamp-us/phoenix/issues/8049) adds it. |
| `--claude-home` | Root of a Claude-Code-shaped `projects/` tree to read instead of the harness's own Claude home. The skill points it at the results directory so nothing outside the gitignored tree is written or assumed. |
| `--repo` | The checkout whose sessions are in scope, matched against each session's recorded working directory. |
| `--skills-dir` | Extra project-skills root for detection. Required here — fabrika's corpus at `claude-plugins/fabrika/skills` is outside the three roots upstream auto-discovers; [#8051](https://github.com/kamp-us/phoenix/issues/8051) removes the need. |
| `--days` / `--max-sessions` | The sampling window and cap. The skill body fixes `45` and `20` as its standing window. |
| `--all-conversations`, `--include-global-skills`, `--per-skill`, `--no-skill` | Sampling and detection modifiers; the skill body never passes them. |

Outputs, all under `--out`: `inventory.json` (the census: sources scanned, skills found, sessions
in scope and sampled) and `transcripts/` (one condensed transcript per sampled session — the only
text the judging step reads). `scripts/warp_decoder.py` is the Warp-specific decoder the collector
loads when `--harness warp` is in play.

## Scoring contract

The judging step is the skill's only model judgment. Read both scorers whole —
[`scorers/efficiency.md`](scorers/efficiency.md) and
[`scorers/code-quality.md`](scorers/code-quality.md) — then score each condensed transcript:

- **Efficiency** — one label: `highly_efficient` (1), `mostly_efficient` (0.8),
  `mostly_inefficient` (0.4), `highly_inefficient` (0.2), with the rubric's reason.
- **Code quality** — one verdict on conversations that produced code changes: `approve` (1) or
  `block` (0.2), with the rubric's reason; `insufficient_evidence` (0.5) when the transcript
  shows too little of the change, and the session is then excluded from the code-quality mean.
- **Skill coverage** — a session counts as covered when the collector detected at least one
  installed skill in it; coverage is the covered fraction of sampled sessions.

Aggregation, upstream's verbatim formulas:

```
raw_efficiency   = mean of efficiency scores across all scored sessions
raw_code_quality = mean of code-quality scores, excluding insufficient_evidence
curve(score)     = 0.5 + 0.5 * score
skill_coverage   = covered sessions / sampled sessions
overall          = 0.5 * curve(raw_efficiency) + 0.35 * curve(raw_code_quality) + 0.15 * skill_coverage
```

A session whose raw score on an applicable scorer is below 0.5 is a **failed conversation**.
Failed conversations are the only evidence that may drive proposed skill edits, and only when
the failure's cause is a missing or wrong instruction on a concrete surface — the gate and the
edit-drafting discipline are [`references/skill-improvements.md`](references/skill-improvements.md),
read whole before drafting any edit. Opening no edit and saying why, per finding, is a recorded
success.

## Report artifacts

`scripts/render_report.py` reads one argument — the `report.json` path — and writes
`report.html` beside it. The schema:

```json
{
  "title": "Agent Skill Report",
  "generated_at": "<ISO-8601 instant>",
  "harness": "claude",
  "handle": "<repo basename>",
  "stats": {
    "sessions_analyzed": 0,
    "sessions_scanned": 0,
    "skills_found": 0,
    "skills_used": 0,
    "window_days": 45
  },
  "scores": {
    "efficiency": 0.0,
    "code_quality": 0.0,
    "skill_coverage": 0.0,
    "overall": 0.0
  },
  "top_findings": ["<one string per finding, each grounded in cited sessions>"],
  "suggestions": [],
  "cta_url": "https://warp.dev/factories/request-access"
}
```

The renderer grades `overall` on the upstream letter scale and produces a self-contained HTML
page (the `assets/` bundle is its rendering payload). **Everything under
`claude-plugins/fabrika/skills/skill-doctor/results/` is machine-local** — gitignored, never
committed, never attached to an issue or PR — because transcripts, inventories, and the rendered
page all embed transcript-derived content and absolute local paths. The rendered page currently
carries upstream's branding and a share button; it is internal-only until
[#8052](https://github.com/kamp-us/phoenix/issues/8052) re-brands it and
[#8054](https://github.com/kamp-us/phoenix/issues/8054) rules the share posture. Findings text,
redacted, is the only quotable surface.
