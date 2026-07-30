#!/usr/bin/env bash
# Step 3d — the comment-discipline scan (ADR 0119): the added lines this PR introduced on
# comment-bearing code files, plus the §ZS #1 scope line. Extracted from review-code/SKILL.md
# (#4451, epic #4435 phase 1). Extraction contract: ../SKILL.md § The extracted scripts.
#
# The scan ARMS the judgement, it never decides it — WHICH of these lines are comments, and which of
# those earn their place, is the reviewer's call per the `deslop-comments` rubric (a regex cannot
# tell a load-bearing KEEP note from narration slop, which is the point). So the lines themselves go
# to stdout after the scope line: the fence left them in `$ADDED_ON_CODE` for the reviewer to read,
# and a script boundary has no shell variable to hand back.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: comment-scan.sh <pr>" >&2; exit 2; }
PR="$1"

# the added lines this PR introduced on comment-bearing code files, off the diff Step 2 already
# loaded (the reviewer judges WHICH are comments per the deslop-comments rubric — a regex can't,
# which is the point). Emit the scanned scope (§ZS #1) so a future drift that silently stops
# finding added comment lines is visible in the run output rather than reading green.
ADDED_ON_CODE="$(gh pr diff "$PR" \
  | awk '/^\+\+\+ b\/.*\.(ts|tsx|js|jsx|css)$/{f=substr($0,7);next} /^\+\+\+ /{f=""} f && /^\+[^+]/{print f": "substr($0,2)}')"
echo "comment-discipline: scanned $(printf '%s\n' "$ADDED_ON_CODE" | grep -c . || echo 0) added line(s) on comment-bearing files"
printf '%s\n' "$ADDED_ON_CODE"
