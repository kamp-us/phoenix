# ADAPTATION.md — Warp Skill Doctor → Fabrika import PoC

Deviation ledger for the local, untracked import candidate at
`claude-plugins/fabrika/skills/skill-doctor/`.

- **Upstream:** `warpdotdev/common-skills` @ `0254cbe9b73f1171028ce82b9825d232791bab8b`
  (2026-08-28, "Curve skill-doctor grades and filter edits by failures (#81)"), path
  `.agents/skills/skill-doctor/`, MIT (Copyright (c) 2026 Denver Technologies, Inc.).
- **Import rule followed:** copy faithfully, preserve copyright/MIT attribution, make only
  the minimum compatibility changes Fabrika requires; do not redesign the scoring model or
  replace the LLM evaluation.

## File-level mapping (upstream → local)

| Upstream file (under `.agents/skills/skill-doctor/`) | Local destination (under `claude-plugins/fabrika/skills/skill-doctor/`) | Content |
|---|---|---|
| `SKILL.md` | `SKILL.md` | byte-exact (git blob SHA `9fd7d77d…`) |
| `references/supported-harnesses.md` | `references/supported-harnesses.md` | byte-exact (`a7bf9446…`) |
| `references/skill-improvements.md` | `references/skill-improvements.md` | byte-exact (`bbf1dace…`) |
| `scorers/efficiency.md` | `scorers/efficiency.md` | byte-exact (`28648134…`) |
| `scorers/code-quality.md` | `scorers/code-quality.md` | byte-exact (`59179f8d…`) |
| `scripts/collect_sessions.py` | `scripts/collect_sessions.py` | byte-exact (`a1842a5d…`) |
| `scripts/render_report.py` | `scripts/render_report.py` | byte-exact (`972da3be…`) |
| `scripts/test_collect_sessions.py` | `scripts/test_collect_sessions.py` | byte-exact (`e71dc098…`) |
| `scripts/test_render_report.py` | `scripts/test_render_report.py` | byte-exact (`46658d0f…`) |
| `scripts/warp_decoder.py` | `scripts/warp_decoder.py` | byte-exact (`c54cebdd…`) |
| `assets/pierre-diffs.js` | `assets/pierre-diffs.js` | byte-exact (`1ecc2c99…`) |
| `assets/warp-pixel-icon.svg` | `assets/warp-pixel-icon.svg` | byte-exact (`0ed8d084…`) |
| *(repo-root `LICENSE`)* | `LICENSE` | byte-exact copy of the upstream repo's MIT license text |
| *(none)* | `PROVENANCE.md` | **added** (see deviation 1) |

Verification: each file's git blob SHA-1 (`sha1("blob <len>\0" + content)`) was computed
locally and compared against the SHAs the GitHub tree API reports for the upstream commit.
All 12 upstream files match exactly.

## Deviations

### 1. Added `PROVENANCE.md` (upstream: none)

- **Upstream:** no such file; upstream marks provenance via the repo-root LICENSE only.
- **Local:** `claude-plugins/fabrika/skills/skill-doctor/PROVENANCE.md`.
- **Change:** a short provenance/attribution note (upstream link, commit SHA, MIT
  attribution, byte-exactness claim, re-sync rule).
- **Why Fabrika requires it:** fabrika's imported-skill precedent (`writing-for-agents`)
  carries an in-directory attribution note + LICENSE, and fabrika skills live inside the
  plugin directory where the upstream repo-root LICENSE is not visible. The repo's
  conventions also require that an imported doc state its lineage so a future maintainer
  re-syncs from upstream rather than editing in place.
- **Behavior change:** none. Pure documentation; no runtime file reads it.

### 2. Added `LICENSE` inside the skill directory (upstream: repo root only)

- **Upstream:** the MIT license lives at the `common-skills` repo root, not inside
  `.agents/skills/skill-doctor/`.
- **Local:** `claude-plugins/fabrika/skills/skill-doctor/LICENSE` — a byte-exact copy of
  the upstream repo-root MIT license text.
- **Change:** duplication of the license into the skill directory.
- **Why Fabrika requires it:** when this skill directory is copied or consumed out of
  phoenix (as fabrika skills are consumed from the plugin), the upstream repo-root
  license does not travel with it. MIT requires the copyright + permission notice
  accompany "copies or substantial portions of the Software"; shipping the skill without
  the notice in reach would violate the license's one condition. Precedent:
  `writing-for-agents/LICENSE`.
- **Behavior change:** none. Documentation only.

### 3. None — no file content was modified

- **Upstream section / local section:** every upstream file body.
- **Change:** none. All 12 upstream files are byte-exact.
- **Why:** the PoC's stated rule — copy faithfully, minimum compatibility changes.
  Fabrika's skill conventions (two-layer split, contract.md, verb-served lookups) would
  demand restructuring for a *production* import (see REPORT.md §12), but those are
  import-time decisions requiring maintainer sign-off, not silent PoC edits. The one
  place fabrika's rules *do* bite at runtime — the nonstandard skills path — is handled
  by upstream's own `--skills-dir` flag, not a code change (see deviation-class B below).

## Configuration-only adaptations (no file changes; documented invocation deltas)

These are not file deviations — the upstream files are untouched — but they are real
differences in how the skill must be *invoked* on this machine, required by phoenix's
environment. Each is evidence for the production-import decision.

### B1. Skills discovery — nonstandard fabrika skills path

- **Upstream contract:** `collect_sessions.py --repo <phoenix>` discovers project skills
  only under `<repo>/.agents/skills`, `<repo>/.claude/skills`, `<repo>/.codex/skills`
  (per `references/supported-harnesses.md` § Skill locations).
- **Local reality:** phoenix's fabrika skills live at `claude-plugins/fabrika/skills`
  (wired into opencode via `opencode.json` `"skills": {"paths": [...]}`), and
  `<repo>/.claude/skills` holds unrelated ctx-* skills (opencode `ctx` plugin), not
  fabrika's.
- **Adaptation used:** upstream's own `--skills-dir claude-plugins/fabrika/skills` flag
  (documented in SKILL.md Step 1 "Useful flags" for exactly this case). No code change.
- **Behavior change:** none in the script; the flag is upstream-supported configuration.

### B2. Executing harness — opencode is outside upstream's startup gate

- **Upstream contract:** `references/supported-harnesses.md` § Startup gate: supported
  executing harnesses are Warp, Claude Code, Codex; anything else must stop before
  creating a report directory or reading conversation history.
- **Local reality:** the harness executing skills in this repo is opencode (opencode.json
  + `~/.local/share/opencode`), which is not in the table.
- **PoC handling:** followed the PoC instruction — "if Skill Doctor cannot discover
  Fabrika's nonstandard skill path, adapt only discovery/configuration and document it";
  the *scoring run itself* was executed by the opencode session acting as Skill Doctor's
  "local agent process" (SKILL.md Step 2: "Score batches in the current local agent
  process, or delegate only to local child agents"). The scripts were run by that agent
  process; no simulator, no replacement scorer was used.
- **Behavior change:** none to the imported files; this is the documented consequence of
  running an unsupported-harness skill from a different host harness.

### B3. Conversation source — no Claude Code/Codex/Warp history for phoenix on this machine

- **Upstream contract:** collectors exist for Claude Code project JSONL, Codex rollout
  JSONL, and Warp SQLite.
- **Local reality (census, metadata only):** `~/.claude/projects` is empty; `~/.codex`
  holds 293 rollouts, none for this checkout (newest is 2026-06-05, another repo), none
  within the 45-day default window; no Warp data. The only real phoenix-local agent
  history on this machine is opencode's own store (`~/.local/share/opencode`), which
  upstream has **no collector for**.
- **PoC handling:** BLOCKED at the transcript-scoring step for the *upstream collectors*.
  What this experiment did instead — using the real opencode conversations through an
  upstream-shaped adapter *external to the imported skill* — is documented in
  REPORT.md §6, and the adapter lives outside the skill directory (in the results
  directory, clearly labeled). It converts opencode's SQLite rows into Claude-Code-shaped
  JSONL files under a temporary claude-home, then the **unmodified upstream**
  `collect_sessions.py` parses those files with its real Claude Code parser. The
  transcripts, sampling, stats, rubrics, scoring, aggregation, and rendering are all the
  upstream pipeline's. The adapter is a translation shim for one unsupported *source*,
  not a replacement scorer.
- **Behavior change:** none to the imported files. The adapter is invoked, never merged.

### B4. Python interpreter availability

- **Upstream contract:** SKILL.md says `python3`. This machine's Windows Python is
  `python` (3.12.10); `python3` also resolves.
- **Adaptation:** invocation used `python`. No file change.

## Not done (and why)

- **No restructure to fabrika's two-layer skill split** (SKILL.md-as-router +
  contract.md depth). That is a production-import decision (REPORT.md §12), not a PoC
  compatibility requirement — making it here would redesign upstream's shape against the
  "copy faithfully" rule.
- **No `contract.md` added.** Upstream has none; adding one would be an undocumented
  structural deviation. Left for the production decision.
- **No description/frontmatter edits** beyond upstream's own frontmatter (which already
  has `name` + `description`, the fields fabrika skills carry).
- **No changes to scoring, aggregation, letter-grade curve, or the failed-conversation
  filter.** The rubrics, curve formula (`0.5 + 0.5 * score`), overall weights
  (`0.5/0.35/0.15`), and edit-gating on failed conversations are upstream's, untouched.
