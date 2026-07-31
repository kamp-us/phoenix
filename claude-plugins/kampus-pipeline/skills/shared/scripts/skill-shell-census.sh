#!/usr/bin/env bash
# THE CORPUS RE-COUNT — epic #4435's done-proof, as a committed runnable harness rather than a recipe
# pasted into a PR body (#4454 AC5: the fence matcher must be reproducible by a reviewer against the
# merged tree, and a matcher that lives only in prose cannot be re-run at the next SHA).
#
# usage: skill-shell-census.sh [<skills-dir>]
#
# Prints one `blocks<TAB>lines<TAB>path` row per markdown file that still carries a fenced bash/sh/shell
# block, then a `TOTAL` row. Files with zero blocks are omitted from the rows and counted in the scanned
# total, so "no rows" and "nothing scanned" are distinguishable.
#
# THE MATCHER, stated once so a reader need not infer it from the awk: a block opens at a line whose
# first non-blank token is ``` immediately followed by `bash`, `sh` or `shell` (any trailing info string
# is ignored) and closes at the next ``` line. Lines strictly between the fences are shell lines. It is
# deliberately WIDER than the epic-plan recipe's `^```(bash|sh)$`, which missed an indented fence and a
# `shell`/info-string fence — a matcher that under-counts would report a zero the corpus does not have.
#
# ZERO SCOPE FAILS (§ZS / ADR 0092): a run that scans no markdown files at all exits 4, because zero
# blocks over zero files is the same output as zero blocks over the whole corpus, and that is the
# permissive answer this harness exists to make unavailable.
#
# `set -uo pipefail` without `-e`, and no `EXIT` trap: on bash 3.2 a `set -u` abort that reaches an
# `EXIT` trap yields exit **0**, so a fail-closed harness would exit clean having printed its FAIL
# (#4476, class #4479).
set -uo pipefail

# shellcheck disable=SC1007  # `CDPATH= cd` clears CDPATH for this one command — the corpus idiom
DEFAULT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILLS_DIR="${1:-$DEFAULT_DIR}"
[ -d "$SKILLS_DIR" ] || { echo "skill-shell-census: '$SKILLS_DIR' is not a directory — NOTHING was scanned (§ZS: not a zero count)."; exit 2; }

FILES="$(find "$SKILLS_DIR" -type f -name '*.md' | LC_ALL=C sort)"
[ -n "$FILES" ] || { echo "skill-shell-census: no *.md under '$SKILLS_DIR' — ZERO SCOPE, which is a failure and NOT a zero-glue proof."; exit 4; }

SCANNED=0
TOTAL_BLOCKS=0
TOTAL_LINES=0
while IFS= read -r f; do
	[ -n "$f" ] || continue
	SCANNED=$((SCANNED + 1))
	row="$(awk '
		/^[ \t]*```/ {
			if (!inb) {
				lang = $0
				sub(/^[ \t]*```[ \t]*/, "", lang)
				sub(/[ \t].*$/, "", lang)
				if (lang == "bash" || lang == "sh" || lang == "shell") { inb = 1; blocks++ }
				next
			}
			inb = 0
			next
		}
		inb { lines++ }
		END { printf "%d\t%d\n", blocks + 0, lines + 0 }
	' "$f")"
	b="${row%%	*}"
	l="${row##*	}"
	TOTAL_BLOCKS=$((TOTAL_BLOCKS + b))
	TOTAL_LINES=$((TOTAL_LINES + l))
	[ "$b" -gt 0 ] && printf '%s\t%s\t%s\n' "$b" "$l" "${f#"$SKILLS_DIR"/}"
done <<EOF
$FILES
EOF

printf 'TOTAL\tfiles-scanned=%d\tblocks=%d\tshell-lines=%d\n' "$SCANNED" "$TOTAL_BLOCKS" "$TOTAL_LINES"
