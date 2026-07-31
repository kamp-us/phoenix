#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step 3.5's `claim_is_mine <N>` — the guard MANDATED before every issue/PR-number mutation.
#
# Extracted VERBATIM from write-code/SKILL.md's `claim_is_mine` fenced block (epic #4435 phase 1,
# #4449). A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2
# (#1929) — the body already IS the verb, so ADR 0228 keeps it a relay: it passes the verb's exit
# status through and never re-derives the ownership decision.
#
# SOURCED, never executed — leaving `claim_is_mine` in the sourcing shell is the whole point. Sets
# NO shell options; no EXIT trap (under bash 3.2 a cleanup trap's last command becomes the script's
# status, laundering a `set -u` abort into exit 0 — #4476, class #4479). The verb is default-deny, so
# the function's EXIT STATUS is the entire contract: never swallow it.
#
# The block's trailing ILLUSTRATION of the calling convention
# (`claim_is_mine "<N>" && gh api …/comments -f body="…"`) deliberately did NOT move here: it is a
# metavariable-carrying example, and a moved copy would be a runnable line that posts a literal `…`
# comment. It stays in SKILL.md next to this file's invocation, where it is documentation.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# claim_is_mine <N>: resolve the EARLIEST AUTHORIZED claim marker on #N (issue or PR) and assert
# its embedded session id == MY_CLAIM. Returns 0 only on a proven-own claim; non-zero (REFUSE) on
# an absent OR a foreign claim. The ADR-0115 §2 resolution — CLAIM_RE + the write+ ACL trust root
# (ADR 0055) + the earliest-(created_at, comment id) tiebreak — is owned once by the shared verb
# `pipeline-cli claim is-mine`; CITE it, never hand-roll the jq (#3687, the same envelope
# extraction the shipped review-verdict and tracker verbs underwent). The verb is default-deny: an absent claim, an
# unauthorized-only claim, a foreign owner, and a missing session all resolve NOT-mine (exit
# non-zero) — exactly this guard's fail-closed refusal, so the exit-status contract is preserved.
claim_is_mine() {
  "$PCLI" claim is-mine --issue "$1" --session "$MY_CLAIM"   # exit 0 = mine; non-zero = REFUSE (default-deny)
}
