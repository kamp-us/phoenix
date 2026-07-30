#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step 4's branch cut: fetch the base fresh, derive the prefix from this checkout's git identity, and
# create the per-run branch off FETCH_HEAD under `wt_preflight`.
#
# Extracted VERBATIM from write-code/SKILL.md's Step 4 branch fenced block (epic #4435 phase 1,
# #4449). A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2
# (#1929).
#
# SOURCED, never executed. $BRANCH and $PREFIX must land in the sourcing shell exactly as the inline
# block left them, so this file sets NO shell options. It calls `wt_preflight`, which SKILL.md's
# per-mutation-preflight blockquote defines in that same shell — sourcing (not executing) is what
# keeps that function reachable. No EXIT trap: under bash 3.2 a cleanup trap's last command becomes
# the script's status, laundering a `set -u` abort into exit 0 (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# The one seam this move needed: the block's `<slug-for-issue-N>` metavariable was substituted by
# whoever ran the step, so the sourcing site passes the kebab-case slug instead. Fail closed on an
# absent one — an empty slug yields `$PREFIX/-<nonce>`, a branch name that is legal, meaningless, and
# names no issue.
SLUG="${1:-}"
if [ -z "$SLUG" ]; then
  printf 'write-code Step 4: no branch slug — source this as `. "$WRITECODE_SCRIPTS/step4-branch.sh" <slug-for-issue-N>`. NO branch was created.\n' >&2
  return 1
fi
# Fetch the base fresh, and FAIL-LOUD if it doesn't run: FETCH_HEAD is what the branch below is
# cut from, so a silently-failed fetch (network blip, a harness worktree whose exec env stripped
# PATH) leaves FETCH_HEAD at a STALE prior tip, and the branch misses a base file merged just
# before branch-cut → the SHA-bound run-evidence check false-fails on a file the head never
# carried (#1920; the same stale-base class #1837 fixed at the repair step). Never proceed on an
# unverified fetch — assert it succeeded before branching off FETCH_HEAD.
git fetch origin main || { echo "write-code: 'git fetch origin main' failed — refusing to branch off a stale FETCH_HEAD (would cut a head missing a just-merged base file; #1920)." >&2; exit 1; }
# Derive the prefix from THIS checkout's git identity — never a hardcoded literal. A copied
# literal namespaces every agent's branch under one person's handle regardless of who runs.
PREFIX="$(git config user.name | tr '[:upper:] ' '[:lower:]-')"   # e.g. "Umut Sirin" → "umut-sirin"
: "${PREFIX:?set git user.name to derive a branch prefix}"        # empty identity ⇒ "/slug…" (leading slash) git rejects with an opaque error; fail here with a fixable one
# Per-run suffix: the deterministic $PREFIX/<slug-for-issue-N> is the SAME ref for every
# run on this issue, so two concurrent runs would both push origin/<that branch> and the
# second push would clobber the first's commits. A per-invocation nonce keeps them distinct.
BRANCH="$PREFIX/$SLUG-$(uuidgen | head -c 8)"
wt_preflight && git switch -c "$BRANCH" FETCH_HEAD   # branch create is a git mutation → gate it (per-mutation preflight above)
