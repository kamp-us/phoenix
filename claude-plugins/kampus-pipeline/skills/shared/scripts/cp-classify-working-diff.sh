#!/usr/bin/env bash
# §CP self-check over your OWN uncommitted work, before you open the PR: classify every path in
# `git diff --name-only origin/main...`. Proven-ordinary ⇒ exit 3. control-plane ⇒ exit 0 ⇒ something
# under your diff is owned; find it.
#
# usage: cp-classify-working-diff.sh
#
# This lives in `shared/scripts/` and not under a `<skill>/scripts/` directory because its caller,
# `../../taste-library-conventions.md`, is a CROSS-SKILL standards doc — it governs every `taste-*`
# skill and owns no skill directory of its own. It is `.sh` under `skills/`, which is the property that
# matters: `.github/CODEOWNERS` gates `/claude-plugins/kampus-pipeline/skills/**/*.sh` to
# @kamp-us/control-plane and §CP's CONTROL_PLANE_RE carries the matching branch (ADR 0174), so no new
# destination is invented and no ungated window opens (#4446).
#
# Relays the verb's own exit status (ADR 0228); it derives no §CP answer. A non-zero-and-not-3 exit
# means the classification never ran — UNKNOWN, never "ordinary".
#
# Extracted from taste-library-conventions.md (#4454, epic #4435 phase 1).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

PCLI="$(kp_pcli)" || { echo "BLOCKING (§CP classifier could not run — the CLI shim is unresolved; UNKNOWN, never 'ordinary')"; exit 1; }

git diff --name-only origin/main... | "$PCLI" cp-classify classify
