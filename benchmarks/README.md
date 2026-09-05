# benchmarks

Evaluation of [Warp Skill Doctor](https://github.com/warpdotdev/common-skills/tree/main/.agents/skills/skill-doctor)
(MIT) as a benchmark for fabrika's skills, per
[Discussion #7319](https://github.com/kamp-us/phoenix/discussions/7319). Local-only
proof of concept: not a workspace member, not wired into CI or `pnpm`, runs standalone.

## Contents

| Path | What it is |
|---|---|
| [`warp-skill-doctor-import-poc/REPORT.md`](warp-skill-doctor-import-poc/REPORT.md) | Full experiment record: method, scores, findings, portability notes, verdict |
| [`warp-skill-doctor-import-poc/ADAPTATION.md`](warp-skill-doctor-import-poc/ADAPTATION.md) | Deviation ledger for the import (what is upstream's, what is ours, why) |
| [`warp-skill-doctor-import-poc/ISSUE_DRAFT.md`](warp-skill-doctor-import-poc/ISSUE_DRAFT.md) | Ready-to-file tracking issue: five blockers between this PoC and a production import |
| [`warp-skill-doctor-import-poc/results/`](warp-skill-doctor-import-poc/results/) | Run artifacts (gitignored; see [Privacy](#privacy)) |
| `claude-plugins/fabrika/skills/skill-doctor/` | The import candidate: 12 upstream files byte-exact, plus our `LICENSE` + `PROVENANCE.md` |

## Verification

Upstream test suites (run from the skill's `scripts/`, Python 3.12, Windows):

```bash
PYTHONUTF8=1 python test_collect_sessions.py   # 14 tests — OK
PYTHONUTF8=1 python test_render_report.py      # 11 tests — OK
```

**25/25 passing** as of 2026-09-06, at upstream pin `b811c24365ae`.

End-to-end pipeline, re-verified 2026-09-06: opencode→Claude-Code adapter (2 real
local sessions) → unmodified upstream collector (2 sampled, 27 skills found) →
rubric judging → upstream aggregation → `render_report.py`. Result: **B+
(overall 0.88)** — efficiency 0.90, code quality 0.80, skill coverage 1.0 —
identical to the original 2026-08-31 run. The score rests on 2 sessions and is
directional only, not a measurement of the corpus.

## Status

Verdict: **revise before import.** The five blockers and their evidence are in
[`ISSUE_DRAFT.md`](warp-skill-doctor-import-poc/ISSUE_DRAFT.md), filed as the
tracking issue
[#8035](https://github.com/kamp-us/phoenix/issues/8035) (`status:needs-triage`,
2026-09-06). Headline: upstream
has no opencode collector (the only real session source on this machine), a
Windows/UTF-8 portability bug survives in the scripts, the report ships
share-by-default with vendor branding, and the import does not yet meet fabrika's
skill conventions.

Upstream pin: `b811c24365ae` (2026-09-03). Originally imported at `0254cbe9`
(2026-08-28); re-synced byte-exact on 2026-09-06 after upstream landed ZCode/Pi
harness support (#93) and complete-session streaming (#92). Re-sync policy: re-copy
from upstream, never edit in place (see the candidate's `PROVENANCE.md`).

## Privacy

`warp-skill-doctor-import-poc/results/` contains **real conversation transcripts**,
census inventories with absolute local paths, and an upstream-rendered `report.html`
embedding transcript-derived content. Everything except `results/opencode_adapter.py`
is gitignored. Never commit, attach, or share that directory; the adapter shim is
tracked because `REPORT.md` cites it and it carries no session content.
