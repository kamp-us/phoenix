#!/usr/bin/env bash
# Apply the triage verdict to #N: the type + priority labels and the status transition, through the
# one verb that owns that label write.
#
# usage: apply-triage.sh <N> <type> <priority> [--status <stage>]
#        apply-triage.sh <N> --status <stage>            # the un-classified park (e.g. needs-info)
#
# EVERY argument reaches the verb, or the script refuses. The shape it replaced took `-ge 3` and
# forwarded `$1 $2 $3`, so `apply-triage.sh <N> <type> <priority> --status needs-info` — the exact
# invocation ../SKILL.md § Apply the labels tells a triager to use — was accepted, dropped on the
# floor, and exited 0 having stamped `status:triaged` instead. That drop fails OPEN: `status:triaged`
# + unassigned is precisely what write-code's picker selects on, so an issue someone deliberately
# tried to hold landed pickable with no signal to anyone (#4936). Hence the parse below: an
# unrecognized flag, a `--status` with no stage, and an off-contract positional count are all fatal,
# and a partial application is unreachable.
#
# Extracted from triage/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

usage() {
	cat >&2 <<'EOF'
usage: apply-triage.sh <N> <type> <priority> [--status <stage>]
       apply-triage.sh <N> --status <stage>            # the un-classified park (e.g. needs-info)
EOF
}

refuse() {
	printf 'apply-triage.sh: %s\n' "$1" >&2
	usage
	exit 2
}

STATUS="triaged"
STATUS_SEEN=0
POSITIONAL=()

while [ "$#" -gt 0 ]; do
	case "$1" in
		--status)
			[ "$STATUS_SEEN" -eq 0 ] || refuse "--status given more than once"
			[ "$#" -ge 2 ] || refuse "--status needs a stage (e.g. --status needs-info)"
			STATUS="$2"
			STATUS_SEEN=1
			shift 2
			;;
		--status=*)
			[ "$STATUS_SEEN" -eq 0 ] || refuse "--status given more than once"
			STATUS="${1#--status=}"
			[ -n "$STATUS" ] || refuse "--status needs a stage (e.g. --status needs-info)"
			STATUS_SEEN=1
			shift
			;;
		-*)
			refuse "unrecognized flag '$1' — this wrapper forwards --status only"
			;;
		*)
			POSITIONAL+=("$1")
			shift
			;;
	esac
done

# The positional contract is exact, never `-ge`: an extra bare word is as silently dropped as an
# extra flag was, so `<N> <type> <priority> extra` is refused on the same footing.
case "${#POSITIONAL[@]}" in
	3) ;;
	1) [ "$STATUS_SEEN" -eq 1 ] || refuse "a bare <N> applies nothing — give <type> <priority>, or --status <stage> to park it" ;;
	*) refuse "expected 3 positionals (<N> <type> <priority>) or 1 (<N>) with --status, got ${#POSITIONAL[@]}" ;;
esac

TARGET="${POSITIONAL[0]}"
case "$TARGET" in
	'' | *[!0-9]*) refuse "<N> must be an issue number, got '$TARGET'" ;;
esac

PCLI="$(kp_pcli)" || exit 127

# `--status` is always forwarded, never left implicit: the verb's own default is `triaged`, so
# passing the resolved value changes nothing about the 3-argument path while making "the stage the
# caller asked for is the stage the verb is told" true by construction rather than by defaulting.
if [ "${#POSITIONAL[@]}" -eq 3 ]; then
	"$PCLI" tracker apply-triage "$TARGET" \
		--type "${POSITIONAL[1]}" --p "${POSITIONAL[2]}" --status "$STATUS"
else
	# The park: type and priority are deliberately absent. Whether the stage tolerates that is the
	# domain's call (`classify`), and it refuses loudly before any write — this wrapper never
	# invents a filler classification to fill the gap.
	"$PCLI" tracker apply-triage "$TARGET" --status "$STATUS"
fi
