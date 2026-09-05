# Provenance

Imported verbatim from [`warpdotdev/common-skills`](https://github.com/warpdotdev/common-skills),
`.agents/skills/skill-doctor/`, MIT licensed (Copyright (c) 2026 Denver Technologies, Inc.).
See [`LICENSE`](LICENSE).

- Upstream commit pinned: `b811c24365ae` (2026-09-03, "Stream complete skill-doctor
  session files (#92)") — the latest commit touching `.agents/skills/skill-doctor` at
  import time (2026-09-06).
- **Re-copy, never edit in place.** Every file listed as byte-exact below is upstream's; a
  change to any of them is made upstream and re-copied here, or it silently breaks the re-sync
  property this directory exists for. The fabrika-authored files are the editable surface.

## Byte-exact upstream files — verified by git blob SHA at the pinned commit

| File | Blob SHA |
|---|---|
| `assets/pierre-diffs.js` | `1ecc2c9969141899a25400538a97c2b21a2a172d` |
| `assets/warp-pixel-icon.svg` | `0ed8d0840a3ada909d94f4b5a2817aeb0e46ec53` |
| `references/skill-improvements.md` | `bbf1dace5f5aa98c9b50fed71e436461f1661d4f` |
| `references/supported-harnesses.md` | `e8f589b75b476b119acae42fe3ce05316e37ec50` |
| `scorers/code-quality.md` | `59179f8d85a304c1ebb34f535c5afb6c5b14c37a` |
| `scorers/efficiency.md` | `286481347df1a3b752cc92ccb019a8284bbe9a04` |
| `scripts/collect_sessions.py` | `f24fb5411d18d300b794a295d7632aa335835053` |
| `scripts/render_report.py` | `972da3beacf3709ee6e209841dd47c4ed5a2ab6f` |
| `scripts/test_collect_sessions.py` | `f659ac6eb79c8d66671651ca3b7b8acb4ce4244d` |
| `scripts/test_render_report.py` | `46658d0f716f444412e6d9355153dcb6c3c30204` |
| `scripts/warp_decoder.py` | `c54cebddb691dff72561bd269e0aac11c5498b1f` |
| `LICENSE` | `00bd0da9b68ad483740275a0ec22a864ba8565fc` (upstream repo-root MIT license) |

Upstream's own `SKILL.md` (`9fd7d77d3b3944cbda2b09137001c25af08f598d` at the pinned commit) is
deliberately **not vendored** — it is superseded by the fabrika-authored routing surface below,
per [skill-conventions](../../docs/skill-conventions.md) §1/§2. Its content remains readable
upstream at the pinned commit.

## Fabrika-authored files — editable

| File | Role |
|---|---|
| `SKILL.md` | Fabrika routing and orientation surface (conventions §1/§2). States what the skill is, when to fire it, the step flow with literal commands, and pointers into `contract.md` by section. |
| `contract.md` | The derived contract: collector flags, scoring contract, report artifacts — read by section via `fabrika wire doc-section`. |
| `PROVENANCE.md` | This file: the byte-exact/editable split and the re-sync procedure. |

Later epic children extend the fabrika-authored surface or land new byte-exact re-copies —
[#8049](https://github.com/kamp-us/phoenix/issues/8049) (opencode collector),
[#8050](https://github.com/kamp-us/phoenix/issues/8050) (portability patch),
[#8051](https://github.com/kamp-us/phoenix/issues/8051) (corpus discovery),
[#8052](https://github.com/kamp-us/phoenix/issues/8052) (report re-branding). A child that finds
itself editing a byte-exact file must stop: either the change is upstreamed and re-copied at a new
pinned commit (this table updated with it), or the deviation is a decision that lands in the epic's
record first.

## Re-sync procedure

1. Fetch upstream and find the latest commit touching `.agents/skills/skill-doctor`.
2. Re-copy each byte-exact file from that commit; never apply a local edit.
3. Re-verify every blob SHA against the upstream tree and update the pinned commit and this
   table together.
4. Leave the fabrika-authored files alone — they are not part of a re-sync.

If this procedure ever needs more than this file carries, it moves to a `.patterns/` doc rather
than growing here.
