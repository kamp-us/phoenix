#!/usr/bin/env bash
# Step 5 — the guarded `review-doc` verdict upsert, on the §VERDICT (PR, gate-namespace, head, run)
# key. Extracted from review-doc/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
#
# ONE script for all THREE Step-5 branches — non-blocking PASS, §CP advisory, FAIL. The fences
# differed only in the body they told the reviewer to compose; the mechanism was identical
# (`mktemp` a file, write the body into it, `verdict post --gate doc --body-file`). Collapsing them
# removes two copies of the same upsert rather than preserving a distinction the shell never had.
#
# THE BODY ARRIVES ON STDIN — the declared seam. The fences said "write your composed verdict into
# $VERDICT_FILE", so the body is authored by the reviewing agent and a script can only receive it.
# Stdin also retires the scratch file entirely, which removes the #2683 / #3718 class by
# construction: with no path on disk there is nothing for a concurrent review of the same PR to
# clobber, and no mktemp path that could bleed into the marker's `@ <sha>` field.
#
# The upsert itself stays `pipeline-cli verdict post` — the MANDATED emit choke point. A bare
# `gh api …/comments` hand-post of a marker is FORBIDDEN: it skips `emissionDefect` and the
# §READBACK re-scan (§READBACK of ../../shared/gate-verdict-contract.md; #2789 / #2816 / #2818).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: printf '%s' \"\$BODY\" | verdict-post.sh <pr>" >&2; exit 2; }
PR="$1"
# resolve the verdict CLI via the `bin/pipeline-cli` shim — in-repo bin, else the installed bin,
# else the pinned `pnpm dlx` fallback reading the one pin (hooks/pin.sh); no version pinned here
# (#3653; ADR 0062/0064; epic #994)
PCLI="$(kp_pcli)" || exit 127

BODY="$(cat)"
[ -n "$BODY" ] || { echo "verdict-post.sh: EMPTY body on stdin — refusing to post an empty verdict; the PR would read as UNGATED." >&2; exit 1; }

printf '%s' "$BODY" | "$PCLI" verdict post --pr "$PR" --gate doc   # upsert (PATCH own prior marker, else POST)
