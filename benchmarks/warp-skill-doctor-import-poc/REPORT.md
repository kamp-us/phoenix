# REPORT.md — Warp Skill Doctor → Fabrika import PoC

Local, untracked experiment for [kamp-us/phoenix discussion #7319](https://github.com/kamp-us/phoenix/discussions/7319)
(comment [18202118](https://github.com/kamp-us/phoenix/discussions/7319#discussioncomment-18202118):
"we should import this skill directly into fabrika since it's license is MIT").
Nothing in this experiment was staged, committed, pushed, or published; every artifact stayed
on this machine under `benchmarks/warp-skill-doctor-import-poc/`.

## 1. Upstream commit SHA evaluated

`0254cbe9b73f1171028ce82b9825d232791bab8b` — "Curve skill-doctor grades and filter edits by
failures (#81)", 2026-08-28, the latest commit touching `.agents/skills/skill-doctor` on
`main` at experiment time.

## 2. Upstream source links

- Skill root: https://github.com/warpdotdev/common-skills/tree/main/.agents/skills/skill-doctor
- SKILL.md: https://github.com/warpdotdev/common-skills/blob/main/.agents/skills/skill-doctor/SKILL.md
- Commit: https://github.com/warpdotdev/common-skills/commit/0254cbe9b73f1171028ce82b9825d232791bab8b
- License (repo root, MIT, Copyright (c) 2026 Denver Technologies, Inc.):
  https://github.com/warpdotdev/common-skills/blob/main/LICENSE

## 3. Exact files copied (all byte-exact, git-blob-SHA verified)

All 12 upstream files → `claude-plugins/fabrika/skills/skill-doctor/`:

| File | Bytes | Upstream git blob SHA |
|---|---:|---|
| `SKILL.md` | 9812 | `9fd7d77d3b3944cbda2b09137001c25af08f598d` |
| `references/supported-harnesses.md` | 1801 | `a7bf94467dbbf43f093a81c13f93d43bc0bb4927` |
| `references/skill-improvements.md` | 1948 | `bbf1dace5f5aa98c9b50fed71e436461f1661d4f` |
| `scorers/efficiency.md` | 3340 | `286481347df1a3b752cc92ccb019a8284bbe9a04` |
| `scorers/code-quality.md` | 4781 | `59179f8d85a304c1ebb34f535c5afb6c5b14c37a` |
| `scripts/collect_sessions.py` | 42911 | `a1842a5db35614ed2cc7af4f2fc40631d75cfde9` |
| `scripts/render_report.py` | 26643 | `972da3beacf3709ee6e209841dd47c4ed5a2ab6f` |
| `scripts/test_collect_sessions.py` | 7275 | `e71dc098e0ddd904d497d78844633c26f97c5afb` |
| `scripts/test_render_report.py` | 8922 | `46658d0f716f444412e6d9355153dcb6c3c30204` |
| `scripts/warp_decoder.py` | 11711 | `c54cebddb691dff72561bd269e0aac11c5498b1f` |
| `assets/pierre-diffs.js` | 1156623 | `1ecc2c9969141899a25400538a97c2b21a2a172d` |
| `assets/warp-pixel-icon.svg` | 4443 | `0ed8d0840a3ada909d94f4b5a2817aeb0e46ec53` |

Plus two **added** files (ours, documented in ADAPTATION.md): `LICENSE` (byte-exact copy of
the upstream repo-root MIT license, placed in-skill per the `writing-for-agents` precedent)
and `PROVENANCE.md` (attribution + commit + re-sync note). No upstream file content was
modified — verified by computing each file's git blob SHA-1 locally
(`sha1("blob <len>\0" + content)`) and comparing against the tree-API SHAs for that commit.

## 4. Exact Fabrika compatibility changes

**None to upstream file content.** All compatibility handling was configuration/invocation
only, plus two additive documentation files. Full ledger with upstream/local/change/why/
behavior-change columns: [`ADAPTATION.md`](ADAPTATION.md). Summary:

1. Added `PROVENANCE.md` (no behavior change).
2. Added in-dir `LICENSE` (no behavior change).
3. `--skills-dir claude-plugins/fabrika/skills` — upstream's own flag for nonstandard
   skill locations; fabrika's skills live outside the three roots upstream auto-discovers.
4. `--claude-home <results dir>` — upstream's own flag; fed the adapter output (B3 below).
5. `PYTHONUTF8=1` — Windows Python defaults to cp1252; upstream tests and `read_text()`
   calls without encoding crash on SKILL.md's UTF-8 curly quotes. **This is a genuine
   upstream portability bug** (three `read_text()` calls in `test_render_report.py` lack
   `encoding="utf-8"`), worked around via environment, not a file edit.
6. `python` instead of `python3` (Windows interpreter name).

## 5. Exact invocation used

```powershell
# Step 1 census (metadata only, read-only):
#   claude: ~/.claude/projects empty · codex: 293 rollouts, 0 phoenix, 0 within 45d · warp: absent
#   opencode db: 2 real phoenix sessions (the only phoenix-local conversations on this machine)

# discovery adapter (PoC shim, lives in results/, NOT part of the imported skill):
$env:PYTHONUTF8 = "1"
python benchmarks/warp-skill-doctor-import-poc/results/opencode_adapter.py `
  "benchmarks/warp-skill-doctor-import-poc/results" 10

# Skill Doctor Step 1 — upstream collector, unmodified:
python claude-plugins/fabrika/skills/skill-doctor/scripts/collect_sessions.py `
  --harness claude `
  --claude-home "benchmarks/warp-skill-doctor-import-poc/results/claude-home" `
  --repo . `
  --skills-dir "claude-plugins/fabrika/skills" `
  --out "benchmarks/warp-skill-doctor-import-poc/results/run" `
  --days 45 --max-sessions 10

# Steps 2–4 (scoring, aggregation, edit-drafting): performed by this agent process per
# SKILL.md Step 2 ("Score batches in the current local agent process"), judged against
# the verbatim upstream rubrics in scorers/*.md, aggregated with the verbatim upstream
# formulas. No heuristic judge, no synthetic transcripts.

# Step 5 — upstream renderer, unmodified:
python claude-plugins/fabrika/skills/skill-doctor/scripts/render_report.py `
  "benchmarks/warp-skill-doctor-import-poc/results/run/report.json"
```

Output: `benchmarks/warp-skill-doctor-import-poc/results/run/` — `inventory.json`,
`transcripts/` (2), `report.json`, `report.html` (upstream-rendered, self-contained).

## 6. Number and source of real conversations analyzed

**2**, both real opencode sessions whose recorded working directory is this checkout —
the only phoenix-local agent conversations on this machine:

| Session | Harness | Started (UTC) | Sampled |
|---|---|---|---|
| `ses_faa3e88edffetDsLQT6OoZ3bjk` | opencode (adapted → claude-shape) | 2026-08-31T02:58:57Z | yes |
| `ses_fa7ce1663ffezPDDivvNf0MHIe` | opencode (adapted → claude-shape) | 2026-08-31T14:21:01Z | yes |

The upstream collectors themselves found **0 phoenix sessions** across their supported
sources (claude 0 in window; codex 0 phoenix of 293, newest 2026-06-05; warp absent) —
confirmed by a real upstream dry-run before any adaptation. Because upstream has **no
opencode collector** and its Step-0 startup gate does not list opencode, the run used a
discovery/configuration-only adaptation (pre-authorized by the brief): a translation shim
(`results/opencode_adapter.py`, outside the imported skill) converts the real opencode
SQLite rows into Claude-Code-shaped JSONL under a temporary claude-home; the **unmodified**
upstream collector then parses those files with its real Claude Code code path. Sampling,
stats, transcript condensing, rubrics, scoring, aggregation, and rendering are all upstream's.
No simulator was substituted; without the shim the correct outcome was BLOCKED at
"no eligible real sessions via supported sources" — the shim is the documented
discovery-only adaptation, and this limitation is the experiment's central finding.

## 7. Skill Doctor's actual scores

Upstream's verbatim aggregation over the two scored sessions:

- raw_efficiency = 0.8 (both `mostly_efficient`) → **efficiency = 0.90** (curve 0.5+0.5·s)
- raw_code_quality = 0.6 (`block` 0.2, `approve` 1.0) → **code_quality = 0.80**
- **skill_coverage = 1.0** (2/2 sampled sessions had a detected installed skill)
- **overall = 0.5·0.90 + 0.35·0.80 + 0.15·1.0 = 0.88 → letter grade B+** (upstream renderer)
- failed_conversations (raw score < 0.5 on an applicable scorer): session 1 only
  (code-quality 0.2)

## 8. Top findings and proposed edits

Findings (from Skill Doctor's Step 3, STE-100-style, rendered in `report.html`):

1. **Heuristic-judge substitution in the earlier PoC** (session `ses_faa3e88ed…`): the
   first benchmark build replaced upstream's LLM rubric judgment with a deterministic
   heuristic so it measured pipeline mechanics, not evaluation quality — the failed
   conversation, and the direct motivation for this run's faithful-import approach.
2. **Repeated git-state re-verification** (both sessions): 4+ near-identical
   status/check-ignore rounds before trusting a single answer — bounded, avoidable overhead.
3. **GitHub-HTML-then-API fetch pattern** (both sessions): several wasted webfetches on
   noisy GitHub pages before switching to the API/raw endpoints.

**Proposed skill edits: none.** Upstream's `skill-improvements.md` gates edits on failed
conversations whose root cause is a missing/wrong instruction on a concrete surface, seen
in more than one run or severe enough alone. Finding 1 is exactly the case that fails that
gate: session 1's own brief explicitly requested a deterministic benchmark, so no existing
fabrika instruction was violated — the fix was the maintainer's product decision
(discussion #7319: import the real skill), which this experiment executes, and it is not an
instruction-surface edit. Findings 2–3 occurred in non-failed conversations, which upstream
excludes as edit evidence by design. Per the reference: "open no change and say, per
finding, why not — that is a success."

## 9. Whether each finding is supported by cited local-session evidence

- Finding 1 — **yes**: session `ses_faa3e88ed…`, code-quality scorer, moments where the
  transcript shows `judge.ts` written as a "deterministic stand-in for the upstream LLM
  judge" (transcript lines ~437/481; visible in
  `results/run/transcripts/claude-ses_faa3e88edffetDsLQT6OoZ3bjk.md`).
- Finding 2 — **yes, with a caveat**: both sessions' transcripts show the repeated
  verification rounds (earlier session: the `.gitkeep`/ignore-state loop, ~L552–639;
  current session: 3 git-status rounds). Caveat: `repeated_tool_calls` is inflated by
  near-identical *reads* (webfetch of the same URL returning truncated output), so the
  count alone overstates pure git re-checks; the finding rests on the visible sequences,
  not the counter.
- Finding 3 — **yes**: both transcripts' heads show `webfetch` of `github.com/...` tree/blob
  pages followed by noisy truncated output, then a switch to `api.github.com` / raw URLs.

All three are backed by real local-session citations; none is generic best practice.

## 10. Privacy, portability, and correctness problems

**Privacy.** Good, with two real notes. The upstream skill's own contract is local-only
("Never upload transcripts... The only shareable artifact is the report the user chooses to
post") and the scripts are stdlib-only with no network calls (verified by scanning for
network APIs). Notes: (a) the rendered `report.html` embeds transcript-derived findings and
diff content — it is designed to be *shared*; phoenix must treat it as publishable-by-
default and keep it untracked; (b) the report's share-PNG button and footer carry Warp
Factories CTAs — product branding inside a fabrika plugin.

**Portability.** One genuine upstream bug found: three `read_text()` calls in
`test_render_report.py` (and `discover_skills` in `collect_sessions.py` is exposed on
Windows only via explicit paths) omit `encoding="utf-8"`, so Windows cp1252 crashes on the
UTF-8 smart quotes in SKILL.md — 3/11 render tests fail without `PYTHONUTF8=1`. Also:
`python3` vs `python` naming on Windows; `mktemp -d "${TMPDIR:-/tmp}/..."` (SKILL.md's
REPORT_DIR recipe) is POSIX and would need a Windows path on this machine; `--skills-dir`
must be passed because fabrika's skills path is nonstandard for this repo. The 1.16 MB
`pierre-diffs.js` bundle is heavy for a plugin checkout but required by the renderer.

**Correctness.** Three caveats on this experiment's scores: (1) the transcripts scored are
an adapter's translation of opencode's store into Claude-Code shape — faithful (tool calls,
patched file names, outputs, errors all preserved; verified by SHA-verified byte-exact
upstream parsing and a mid-run adapter fix for the `patch.files` list-vs-dict mistake) but
not a first-party collector, so harness-specific semantics (e.g. opencode `question` tool →
adapter passes through as generic tool) are approximated; (2) the sampled set is 2
conversations, both from 2026-08-31, one of which is the experiment itself — the coverage
and quality numbers are a floor-of-one-machine evidence base, not a robust measurement;
(3) the executing harness (opencode) is outside upstream's supported-harnesses startup
gate — upstream itself would have refused this run; we proceeded under the brief's
pre-authorized discovery-only adaptation. The scores are real Skill Doctor outputs over
real local history, but they inherit all three caveats.

## 11. Recommendation

**Revise before import** — import the asset, but do not land it as-is.

Rationale: the core is genuinely reusable and license-clean (MIT, attribution preserved,
byte-exact import verified possible, upstream tests pass, rubrics are a solid
efficiency/code-quality/coverage model, and it demonstrably produced a coherent B+ report
over real phoenix sessions through its own pipeline). But: it cannot see phoenix's actual
harness history without a shim (no opencode collector; startup gate excludes opencode), it
carries a Windows-encoding portability bug, its discovery misses fabrika's nonstandard
skills path, its report embeds shareable transcript-derived content + Warp CTAs, and it
does not follow fabrika's own skill conventions (no contract.md, `python3`/`mktemp`
POSIX-isms, no `--skills-dir` default for this repo). A direct unmodified import would
install a skill that, in phoenix, cannot run its own Step 0 → Step 1 pipeline without
out-of-band help.

## 12. Exact next changes required for a production-ready import

1. **Add an opencode collector** (upstream contribution or local fork): read
   `~/.local/share/opencode/opencode.db` (tables `session`/`message`/`part`; parts
   `text`/`tool`/`patch`), and add `opencode` to `references/supported-harnesses.md`'s
   startup gate + collector table with source-override flags. Without this the skill is
   inert on phoenix's actual harness. The PoC adapter (`results/opencode_adapter.py`) is a
   working reference for the shape mapping.
2. **Fix the Windows encoding bug** (3 × `read_text()` in `test_render_report.py`, plus
   defensive `encoding="utf-8"` on every read in `collect_sessions.py`) — or document
   `PYTHONUTF8=1` as a requirement; upstreaming the fix is preferable.
3. **Fabrika-ize the invocation layer** per `claude-plugins/fabrika/docs/skill-conventions.md`:
   a `contract.md` holding the depth (collector flags, scoring contract, edit-drafting
   gate), SKILL.md as the routing surface, and `--skills-dir claude-plugins/fabrika/skills`
   encoded in the skill body so the nonstandard path is not caller-supplied.
4. **Localize the scratch dir**: replace the POSIX `mktemp` recipe with a Windows-safe
   REPORT_DIR (or route it under a fabrika scratch verb), and normalize `python3` →
   environment-detected interpreter.
5. **Decide the branding/privacy posture**: keep or strip the Warp Factories footer/CTA
   and share-PNG button; if kept, add a note in the fabrika skill body that `report.html`
   embeds transcript-derived content and must never be committed or posted unreviewed
   (it must stay under an ignored results dir).
6. **Wire validation**: run the two upstream unittest suites (they pass 16/16 with
   `PYTHONUTF8=1`) as part of the import PR's checks, and record the import in the plugin
   manifest's skill list.
7. **Re-sync policy**: PROVENANCE.md already states it — re-copy from upstream on update
   rather than editing in place; pin the upstream commit SHA in the provenance note.

## 13. Full `git status --short`

```
?? benchmarks/
?? claude-plugins/fabrika/skills/skill-doctor/
```

(`benchmarks/` contains the pre-existing untracked `skill-doctor-poc/` from the prior
experiment — untouched by this run — and this experiment's `warp-skill-doctor-import-poc/`.
`claude-plugins/fabrika/skills/skill-doctor/` is this experiment's import candidate.)
No staged files (`git diff --cached` empty), no tracked-file modifications
(`git diff` empty), branch `main` unchanged, no commits made.

## Result

**INCONCLUSIVE-leaning-positive, recommendation: revise before import.** The success
criteria that could be met were met — the real upstream Skill Doctor was imported
byte-exact into fabrika shape, it analyzed 2 real phoenix-local opencode sessions through
its own unmodified pipeline (via a documented, pre-authorized discovery-only shim for the
unsupported source), all outputs and proposed edits stayed local under
`benchmarks/warp-skill-doctor-import-poc/results/`, no skill edits were proposed (none
cleared upstream's own gate), and the evidence is sufficient to decide: the direct import
is worthwhile **after** the revisions in §12 — chiefly the opencode collector, without
which the skill cannot see phoenix's actual history.
