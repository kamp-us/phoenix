#!/usr/bin/env bash
# Config-pin / §HEAD materialization — the fresh base fetch, the head worktree, and the ADR-0052
# instruction-denylist removal + absence assert. Extracted from review-skill/SKILL.md (#4453, epic
# #4435 phase 1). Extraction contract + shell-option rationale: ../SKILL.md § The extracted scripts.
# The *why* for every step stays in that step's prose.
#
# STDOUT IS A MACHINE CHANNEL: the ONLY thing this writes to stdout is the absolute path of the
# run-state handle carrying REVIEW_WT / PR_REF / HEAD_SHA / BASE_REF, so the caller can
# `. "$(materialize-head.sh "$PR")"`. Every progress and FATAL line goes to stderr. On ANY failure
# path stdout stays EMPTY and the exit is non-zero — the caller's `.` then fails loudly rather than
# sourcing a half-written handle. A materialization that could not run is UNKNOWN, and reviewing the
# BASE tree is the #793 false-PASS hazard (§ZS / ADR 0092).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: materialize-head.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || exit 1
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="$(kp_pcli)" || exit 127

BASE_REF="$(gh api repos/"$REPO"/pulls/"$PR" --jq '.base.ref')"   # normally main — your trusted config
[ -n "$BASE_REF" ] || { echo "FATAL: could not resolve the PR's base ref — aborting (the base is half of verification; §HEAD)." >&2; exit 1; }
git fetch origin "$BASE_REF" >&2

# §HEAD steps 1–3 (resolve the live head SHA via REST, fetch pull/$PR/head into a nonce-uniqued
# per-run ref WITHOUT touching the session tree, assert the fetched ref IS that head, add a
# throwaway DETACHED head worktree) are the shared `pipeline-cli review-head materialize` verb
# (#3690 / #793 / #1807) — cite it, don't re-derive it. `pull/<pr>/head` resolves same-repo AND
# cross-fork; the verb never runs `gh pr checkout` / `git checkout` / `git switch` (which would land
# the head in the shared PRIMARY the harness resets this cwd to and detach the human's `main` —
# #2270/#1103; §RO), and it internally aborts on a fetched-ref ≠ resolved-head mismatch (§HEAD #2)
# so you never review a different SHA than the verdict claims. Persist its emitted head/ref/worktree
# to the per-run handle so they survive the harness cwd/shell reset between Bash calls (a shell
# var is lost across calls); re-derive them with `. "$(head-env.sh "$PR")"` at each later step —
# NEVER from a shared leaf name (a `git worktree list` re-derivation matches a SIBLING reviewer's
# tree and reads the wrong head's skill text — the #1807 collision). This is the §SP per-run
# scratchpad namespace (gh-issue-intake-formats.md): a PR number is not unique, and a clobbered file
# reads back cleanly with the other run's content (#3718). The handle is a CROSS-CALL carrier — a
# later step re-derives it — so §SP rules 2+3 apply, NOT the rule-4 single-file `mktemp` carve-out
# (that one is for allocate-and-consume inside one call, like the verdict body): the path is a
# deterministic function of this run's session id, which is what makes it re-derivable at all.
WT_FILE="$(kp_scratch_open "review-skill-head-$PR")/wt.env" || exit 1
"$PCLI" review-head materialize --pr "$PR" --worktree \
  | jq -r '"REVIEW_WT=\(.worktreeDir)\nPR_REF=\(.prRef)\nHEAD_SHA=\(.headSha)"' > "$WT_FILE"
printf 'BASE_REF=%s\n' "$BASE_REF" >> "$WT_FILE"
# shellcheck disable=SC1090  # the run-unique handle this script just wrote
. "$WT_FILE"
[ -n "${REVIEW_WT:-}" ] && [ -n "${PR_REF:-}" ] && [ -n "${HEAD_SHA:-}" ] || {
  echo "FATAL: review-head materialize did not yield a head worktree — aborting (never review the base tree; §HEAD)." >&2; exit 1; }

# Enforce the instruction denylist EXPLICITLY (a full checkout lands the head's root CLAUDE.md
# + .claude/.decisions/.patterns): remove them, then ASSERT absent — the load-bearing isolation
# check. The head's skills/** are present as text to READ; the instruction surfaces are not.
git -C "$REVIEW_WT" rm -r -q --cached --ignore-unmatch \
  CLAUDE.md .claude .decisions .patterns >&2
rm -rf "$REVIEW_WT/CLAUDE.md" "$REVIEW_WT/.claude" "$REVIEW_WT/.decisions" "$REVIEW_WT/.patterns"
for p in CLAUDE.md .claude .decisions .patterns; do
  if [ -e "$REVIEW_WT/$p" ]; then
    echo "FATAL: denied instruction surface '$p' present in review worktree — isolation broken; aborting" >&2
    exit 1
  fi
done

# The handle path — the ONLY stdout line, so the caller can `. "$(materialize-head.sh "$PR")"`.
printf '%s\n' "$WT_FILE"
