#!/usr/bin/env bash
# Entering from a PR: resolve the failing run. Reads the head's CI state through
# `pipeline-cli checks read` (REST check-runs, rolled up latest-per-context, so a superseded red from
# an earlier attempt can't send you at a run that has since gone green — #3762), then resolves the
# first failing context's Actions job id and run id in one REST hop.
#
# usage: resolve-failing-run.sh <pr>
#
# EXIT CODES — read the status BEFORE the stdout (§ZS / ADR 0092). Each is a different fact and the
# caller's prose routes on it; none of them is "nothing is failing":
#   0  red   — stdout `CONTEXT=<name> JOB=<id> RUN=<id>`; go match the taxonomy
#   3  green — nothing to classify, stop
#   4  pending — stdout `running: …` / `wedged: …`; wait (running) or report the stranded contexts
#      (wedged). Rerunning a wedged run is not the lever, and it has produced no log body at all.
#   5  the failing context is NOT a GitHub Actions check — no job, no log; file it via `report` as an
#      unknown, naming the context, and stop
#   1  unreadable — UNKNOWN, which is NOT a green head (#3999)
#   2  usage
#
# THREE FENCES COLLAPSE HERE, and that is the point. The `$CI_JSON` the second and third fences read
# was set by the first, in a DIFFERENT agent shell process — so it was always empty by the time they
# ran, and the resolution was hand-stitched per call. Folding the three into one process is what makes
# the cross-block state survive (epic #4435, story 1); every moved line is otherwise byte-faithful.
# One further seam: the green arm's in-shell `echo … ; exit 0` becomes exit 3, because a script's
# exit 0 means "keep going" to its caller and would read as a red head.
#
# Extracted from heal-ci/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "heal-ci: resolve-failing-run.sh needs a PR number — head CI NOT read (UNKNOWN, not green)."; echo "usage: resolve-failing-run.sh <pr>" >&2; exit 2; }
PR="$1"
PCLI="$(kp_pcli)" || { echo "heal-ci: the CLI shim is unresolved — head CI NOT read (UNKNOWN, not green)."; exit 1; }
REPO="$(kp_repo)" || { echo "heal-ci: target repo unresolved — head CI NOT read (UNKNOWN, not green)."; exit 1; }

CI_JSON="$("$PCLI" checks read --pr "$PR" --expect red 2>/dev/null)"; rc=$?
CONCLUSION="$(printf '%s' "$CI_JSON" | jq -r '.conclusion? // empty' 2>/dev/null)"
case "$rc:$CONCLUSION" in
	0:red) ;; # genuinely red — resolve the failing check's run below
	1:green)
		echo "heal-ci: head is green — nothing to classify"
		exit 3
		;;
	1:pending)
		# A pending head is TWO different facts and only one of them is heal-ci's. `.running` settles
		# on its own — there is no failure to classify yet. `.wedged` is stranded in the queue
		# (`status: queued`, `started_at` still null): it has produced NO log body, and an operator,
		# not a rerun, unwedges it. Collapsing the two is the defect #3999 removed from the merge gate.
		printf 'running: %s\n' "$(jq -r '.running | join(", ")' <<<"$CI_JSON")"
		printf 'wedged: %s\n' "$(jq -r '.wedged  | join(", ")' <<<"$CI_JSON")"
		exit 4
		;;
	*)
		echo "heal-ci: head CI unreadable — re-dispatch once the API answers; an unreadable head is not a green one (#3999)"
		exit 1
		;;
esac

# Take ONE failing context (one routed action per invocation) and resolve its run id. For a GitHub
# Actions check run the check-run `id` IS the Actions job id, so one REST hop yields both JOB and RUN.
FAILING="$(jq -r '.failing[0] // empty' <<<"$CI_JSON")"
[ -n "$FAILING" ] || { echo "heal-ci: head reported red with no named failing context — UNKNOWN, not green."; exit 1; }
HEAD_SHA="$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha')"
[ -n "$HEAD_SHA" ] || { echo "heal-ci: could not read PR #$PR's head SHA — UNKNOWN."; exit 1; }
# The check-runs endpoint returns an object per page, so --slurp is what makes a busy head (>100
# runs) parseable at all. Pick the latest run for the named context — later `started_at` wins,
# ties fall back to the id — the same recency order the rollup used to name it.
JOB="$(gh api --paginate --slurp "repos/$REPO/commits/$HEAD_SHA/check-runs?per_page=100" \
	| jq -r --arg name "$FAILING" '[.[].check_runs[]
			| select(.name == $name and .app.slug == "github-actions")]
			| sort_by(.started_at // "", .id) | last | .id // empty')"
# An empty JOB means the failing context is NOT a GitHub Actions check (a third-party app's check run
# has no Actions job and no log to read). Don't guess at it.
[ -n "$JOB" ] || { echo "CONTEXT=$FAILING JOB= — not a GitHub Actions check: no job, no log. File it via report as an unknown, naming the context."; exit 5; }
RUN="$(gh api "repos/$REPO/actions/jobs/$JOB" --jq '.run_id')"
[ -n "$RUN" ] || { echo "CONTEXT=$FAILING JOB=$JOB — could not resolve the job's run_id (UNKNOWN)."; exit 1; }

printf 'CONTEXT=%s JOB=%s RUN=%s\n' "$FAILING" "$JOB" "$RUN"
