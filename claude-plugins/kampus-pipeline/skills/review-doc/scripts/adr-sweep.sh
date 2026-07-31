#!/usr/bin/env bash
# Step 4a — the citation-independent ADR contradiction sweep. Extracted from review-doc/SKILL.md
# (#4453, epic #4435 phase 1). Extraction contract + shell-option rationale:
# ../SKILL.md § The extracted scripts.
#
# THE EXIT STATUS IS THE ANSWER, and the cleanup must not eat it: exit 0 means the mechanical sweep
# found nothing left to open; non-zero means there is a shortlist to clear, or that the sweep was
# INDETERMINATE and proved nothing. The `SWEEP=$?` capture before the `rm -rf` is what preserves
# that, and it is also why this script installs no `EXIT` trap — under bash 3.2 a cleanup trap's
# last command becomes the script's status, which would report the cleanup instead of the sweep.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: adr-sweep.sh <pr-ref> <.decisions/NNNN-slug.md>" >&2; exit 2; }
PR_REF="$1"; ADR_PATH="$2"
PCLI="$(kp_pcli)" || exit 127

# Runs on Step 2's DEFAULT ref-only path — no `--worktree`, no materialized tree. `--new` takes
# "a path to the ADR file" (any real file, anywhere), so a `git show` off $PR_REF is all the
# "real file on disk" the sweep needs. $PR_REF is bound by Step 2's `review-head materialize`;
# if that ran in an EARLIER Bash call the variable is gone, so re-derive it from Step 2's `head.env`
# via head-env.sh — never re-run the materialize just to rebind it.
# CORPUS: `--dir` is deliberately unset, so the sweep reads the repo-root `.decisions/` of the
# checkout you are running in — the BASE (pre-PR) corpus. That is the set you want: it carries
# every live ADR the new one could contradict, and it excludes the new ADR itself, so the subject
# can never rank against its own file. Only the subject is read from the PR head.
SUBJECT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/review-doc-adr-subject.XXXXXX")"   # §SP rule-4 carve-out: allocated AND consumed in this one call
if [ -z "$SUBJECT_DIR" ] || [ ! -d "$SUBJECT_DIR" ]; then
  echo "adr-sweep.sh: mktemp -d produced no subject dir — the sweep did NOT run (UNKNOWN, never 'nothing to open')." >&2
  exit 1
fi
if ! git show "$PR_REF:$ADR_PATH" > "$SUBJECT_DIR/$(basename "$ADR_PATH")"; then
  echo "adr-sweep.sh: could not read $ADR_PATH at $PR_REF — the sweep did NOT run (UNKNOWN, never 'nothing to open')." >&2
  rm -rf "$SUBJECT_DIR"
  exit 1
fi
"$PCLI" adr-sweep shortlist --new "$SUBJECT_DIR/$(basename "$ADR_PATH")"
SWEEP=$?; rm -rf "$SUBJECT_DIR"   # keep the sweep's status: it, not the cleanup, is the outcome
exit "$SWEEP"
