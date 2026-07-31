#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step 1's three-outcome parent read: sub-issue (200) / standalone (404) / UNKNOWN (anything else).
#
# Extracted VERBATIM from write-code/SKILL.md's "Is it a sub-issue?" fenced block (epic #4435
# phase 1, #4449). A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is
# phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — the moved glue steers its own control flow and depends
# on `pipefail` being OFF — and it leaves its variables in the sourcing shell, which is how the
# steps after it still see $EPIC. No EXIT trap: under bash 3.2 a cleanup trap's last command becomes
# the script's status, laundering a `set -u` abort into exit 0 (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# The one seam this move needed: the block's `<N>` metavariable was substituted by whoever ran the
# step, so the sourcing site passes it instead. Fail closed on an absent one — an empty number
# addresses `repos/$REPO/issues//parent`, whose 404 is INDISTINGUISHABLE from the genuine
# "No parent issue found" 404 that means standalone, i.e. it would answer "standalone" for an
# unnamed issue (the #4171 class this very block exists to close).
N="${1:-}"
if [ -z "$N" ]; then
  printf 'write-code Step 1: no issue number — source this as `. "$WRITECODE_SCRIPTS/step1-parent-resolve.sh" <N>`. NO parent classification was produced (UNKNOWN, not standalone).\n' >&2
  return 1
fi

# `-i` keeps the status line on stdout even when gh exits non-zero, which is the whole point:
# it is what distinguishes a genuine 404 ("No parent issue found" ⇒ standalone) from an
# UNREADABLE response (5xx, rate-limit, auth, network ⇒ UNKNOWN). Collapsing those two into
# "no parent" is a silent no-op that skips Step 2 on a real epic child (#4171, #3715, #4108).
PARENT_RESP="$(gh api "repos/$REPO/issues/$N/parent" -i 2>/dev/null)"
PARENT_STATUS="$(printf '%s\n' "$PARENT_RESP" | head -n1 | awk '{print $2}')"
case "$PARENT_STATUS" in
  200)
    EPIC="$(printf '%s\n' "$PARENT_RESP" | awk 'body{print} /^\r?$/{body=1}' | jq -r '.number // empty')"
    : "${EPIC:?parent read returned 200 with no .number — UNKNOWN, not standalone; refusing to claim $N}"
    echo "#$N is a sub-issue of epic #$EPIC → Step 2 (derive eligibility BEFORE claiming)" ;;
  404)
    echo "#$N is standalone (404 'No parent issue found') → Step 3 (claim it)" ;;
  *)
    echo "write-code FAILED (fail-closed): parent read on #$N returned HTTP '${PARENT_STATUS:-none}' — UNKNOWN, which is NOT evidence of 'no parent'. Refusing to claim: retry, or re-pick per Step 1." >&2
    exit 1 ;;
esac
