#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2317
# SC2317 is on the `return 1 2>/dev/null || exit 1` line: shellcheck reads the file as a script, so
# the `exit` after a top-level `return` looks unreachable. It is exactly reachable in EXECUTED mode,
# where the `return` is the no-op-with-an-error and the `exit` is what stops the run — the whole
# point of the idiom (the same one `shared/scripts/cli-require.sh` uses).
# Step 0's preflight: the §RO-iso isolation assert, guard 6 Site 1, and the changed-file read.
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 0 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step0-preflight.sh <REPO> <PR>
#              stdout ⇒ `PR=<n>` (the run's PR, the one value every later step is re-handed as an
#              argument now that shell state cannot cross a process boundary), then one changed-file
#              path per line. A refusal — the §RO-iso stop or a failed guard-6 Site-1 disarm — prints
#              NO `PR=` line, names itself on stderr, and exits non-zero. Read the status first.
#   SOURCED:   `verify-chain-resolves.sh` check 2 stands this file up against a stubbed `gh`, reading
#              $REPO and $PR out of its own driver shell. That path is untouched, options and all.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479), and this preflight's contract is its
# EXIT STATUS.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
# `disarm_intent` (guard 6 / ADR 0198), sourced IN-CHAIN from its canonical home. The SKILL.md
# preamble used to source it once and leave the function in the agent's shell for the whole chain; a
# process inherits no functions, so every caller pulls it in itself (ADR 0232).
# shellcheck source=disarm-intent.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/." && pwd)/disarm-intent.sh"
# §RO-iso's `iso_preflight`, sourced IN-CHAIN from its canonical home — the extraction dropped this
# line and left the call below command-not-found (#4547). Same idiom as review-code's
# `materialize-head.sh`; never a re-copy of the function.
# shellcheck source=../../shared/scripts/iso-preflight.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/iso-preflight.sh"

# The one seam this move needed: the block's `PR=<pr number>` placeholder was filled by whoever ran
# the step, so the invocation passes it instead. Fail closed on an absent one: an empty $PR addresses
# `repos/$REPO/pulls/` and reads as a clean miss.
REPO="${REPO:-${1:-}}"
PR="${PR:-${2:-}}"
if [ -z "$REPO" ] || [ -z "$PR" ]; then
	printf 'ship-it Step 0: no repo and/or PR number — run this as `bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step0-preflight.sh <REPO> <PR>`.\n' >&2
	# `return` outside a function is a no-op-with-an-error in an EXECUTED script, and the run would
	# carry straight on into the reads below with an empty $PR. The cli-require.sh idiom keeps the
	# sourced path's `return` and gives the executed path the `exit` it needs (ADR 0232).
	return 1 2>/dev/null || exit 1
fi
# `iso_preflight` reads $CLAUDE_CODE_AGENT and $WORKTREE_ROOT UNDEFAULTED, so under executed mode's
# `set -u` an unset one aborts before the guard can answer at all. Bind each to its own current value
# — empty when unset — so the executed form evaluates exactly the branches the no-options sourced
# caller got. The shared function's body stays untouched (the same binding #4571 added at
# `shared/scripts/iso-preflight.sh`'s own entry).
CLAUDE_CODE_AGENT="${CLAUDE_CODE_AGENT-}"
WORKTREE_ROOT="${WORKTREE_ROOT-}"
# Isolation preflight FIRST. ship-it is §RO — it ships entirely over `gh api` / `gh pr merge`
# (server-side) and materializes NO head via local git — so it should never touch the primary
# checkout's git state. This is the defense-in-depth belt: if this ship-it spawn expected worktree
# isolation (shipper agent-type) but the #2440 harness no-op dropped it onto the shared PRIMARY
# checkout ($WORKTREE_ROOT unset — the #2452/#2453 condition), fail closed LOUD and route up rather
# than run any git op there. Single-sourced in gh-issue-intake-formats.md §RO-iso (ADR 0172; the
# write-code wt_preflight sibling). A genuine standalone `/ship-it` on the owner's checkout still proceeds.
# This iso_preflight is ship-it's whole stake in the #2690 worktree-hardening consolidation: LAYER 1
# (prevention) lives here, while LAYER 2 (the clean-tree assertion + the stage-all `git add -A` ban)
# has NO surface in ship-it — it stages/commits nothing — so it is enforced upstream in the pre-bash
# hook + write-code/review-code, not duplicated here.
iso_preflight ship-it || exit 1   # ../gh-issue-intake-formats.md §RO-iso — define it there, cite here

# Guard 6, SITE 1 (ADR 0198) — the first thing after $PR is known and BEFORE any gate branch, so a
# `--auto` armed by an earlier or INTERRUPTED run (#3700's mechanism — the run that reaches no exit
# path of its own, so no `refuse` site ever fires for it) cannot enqueue behind this run's back.
# $REPO was resolved at the top of the skill; $PR one line up. `disarm_intent` is defined in
# "The no-parked-merge-intent invariant" above. Abort on failure: a run that cannot establish the
# intent state cannot honor the invariant at any later site.
disarm_intent preflight || exit 1

# The run's PR, echoed as the positive token every later step is re-handed as an argument. It is the
# evidence this preflight RAN: the file list below can legitimately be short, so its length proves
# nothing, whereas an absent `PR=` line is the refusal (rule 4 / §ZS).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then printf 'PR=%s\n' "$PR"; fi
gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename'   # --paginate + streaming --jq: full set past file #100 (the API caps per_page at 100; #725)
