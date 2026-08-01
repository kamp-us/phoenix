#!/usr/bin/env bash
# Step 5's five post-open seam checks (a)–(e): the cross-reference, the closing/partial-split seam,
# the stray-close inverse guard, the dark-ship `Flag:` guard, and the `## Deviations` presence floor.
#
# usage: step5-seam-checks.sh <N> <PR>
#
# stdout IS the five verdicts, as PROSE the caller reads line by line. Silence is UNKNOWN, never
# "armed" (§ZS / ADR 0092) — which is why each check prints a POSITIVE token on both branches rather
# than staying quiet on the good one.
#
# Check (d) re-derives the containment marker and the cycle-doc probe HERE on purpose (#4398): Step
# 4b's answers were resolved in a different Bash call and are gone. That duplication with
# step4b-containment.sh and shared/scripts/cycle-doc-probe.sh is the moved block's own; collapsing it
# is phase 2's call (#1929).
#
# Executed, never sourced (ADR 0232). `pipefail` is ON now per the shell shape: every check here is an
# `&& echo … || echo …` pair over a pipeline, and turning it on can only move a FAILED read from the
# ordinary branch to the alarm branch — never the reverse — so no check can go quiet that was loud.
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# Each ERE below splices the number by quote-concatenation ('…#'"$N"'\b') rather than switching the
# pattern to double quotes, so the pattern's own bytes are unchanged. Fail closed on an absent one —
# an empty number turns check (b) into a match on any `#`-prefixed digit and check (c) into a stray
# for every issue.
N="${1:-}"
PR="${2:-}"
if [ -z "$N" ] || [ -z "$PR" ]; then
	printf 'write-code Step 5: need both numbers — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step5-seam-checks.sh <N> <PR>`. NO seam check ran (UNKNOWN, never "armed").\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || {
	echo "write-code Step 5: target repo unresolved — NO seam check ran (UNKNOWN, never 'armed')." >&2
	exit 1
}
# (a) the cross-reference landed (a closing OR non-closing mention both show here — necessary, not sufficient)
#     --paginate + a STREAMING --jq, per the contract's pagination rule: the timeline endpoint
#     defaults to 30 events/page, so an un-paginated read calls a cross-reference past event 30
#     absent — a false alarm on any issue with a bit of history (#4193).
gh api --paginate "repos/$REPO/issues/$N/timeline?per_page=100" \
	--jq '.[] | select(.event == "cross-referenced") | .event'
# (b) the SUFFICIENT check, REST-only: the seam is armed iff the body carries EITHER a real
#     CLOSING keyword for #N (full-close PR — the same set ship-it Step 1 resolves:
#     fix(es|ed)/close[sd]?/resolve[sd]?) OR a `Part of #N` partial-split marker (the §9
#     non-closing link that keeps #N OPEN by design). Only NEITHER is a truly broken seam.
BODY=$(gh api repos/$REPO/pulls/$PR --jq '.body')
if printf '%s' "$BODY" | grep -qiE '\b(fix(e[sd])?|close[sd]?|resolve[sd]?)\s+#'"$N"'\b'; then
	echo "closing seam armed"
elif printf '%s' "$BODY" | grep -qiE '\bpart of\s+#'"$N"'\b'; then
	echo "partial-split seam armed — Part of #$N, no closing keyword by design (§9; #$N stays open)"
else
	echo "BROKEN SEAM — body links #$N with neither a closing keyword nor a 'Part of #$N' marker"
fi
# (c) the INVERSE GUARD, REST-only: NO closing keyword targets any issue OTHER than #N.
#     The set {issue numbers preceded by a closing keyword in the body} must be exactly {N};
#     a stray member is a sibling-ref directive that auto-closes an issue this PR never fixed (#1259).
STRAY=$(gh api repos/$REPO/pulls/$PR --jq '.body' \
	| grep -ioE '\b(fix(e[sd])?|close[sd]?|resolve[sd]?)\s+#[0-9]+' \
	| grep -oE '[0-9]+' | sort -u | grep -vx "$N")
[ -z "$STRAY" ] \
	&& echo "no stray close directives — closing-keyword set is exactly {#$N}" \
	|| echo "STRAY CLOSE DIRECTIVE(S) on $(printf '#%s ' $STRAY)— rewrite these sibling refs to a non-closing form (addresses/relates to/see #M) before opening/patching the PR"
# (d) DARK-SHIP GUARD, REST-only: IF Step 4b fired, the body MUST carry a `Flag:` line that
#     matches ship-it Step 5b's FLAG_IN_BODY grep verbatim — else the prior-PR dark ship is dropped
#     from the release queue (#1282). Whether Step 4b fired is RE-DERIVED HERE from durable state —
#     the child's `Containment:` marker and the cycle-doc probe, Step 4b's own two inputs, read in
#     THIS process. It used to key on `[ -n "$FLAG_KEY" ]`, a shell variable Step 4b assigns in a
#     DIFFERENT Bash call: shell state does not survive between calls, so it was empty here and the
#     check silently skipped itself in exactly the case it exists for (#4398).
CONTAINMENT=$(gh api repos/$REPO/issues/$N --jq '.body' \
	| grep -ioE '\**\s*Containment:\**\s*(flag|exempt|none)' | head -n1 \
	| grep -ioE '(flag|exempt|none)' || echo none)
gh api "repos/$REPO/contents/product-development-cycle.md" --jq '.path' >/dev/null 2>&1 \
	&& CYCLE_DOC=present || CYCLE_DOC=absent
if [ "$CONTAINMENT" = flag ] && [ "$CYCLE_DOC" = present ]; then
	gh api repos/$REPO/pulls/$PR --jq '.body' \
		| grep -Eiq '^[[:space:]]*\**[[:space:]]*flag([[:space:]]*key)?:[[:space:]]*\**[[:space:]]*[a-z0-9]+(-[a-z0-9]+)+' \
		&& echo "dark-ship Flag: line present and matches ship-it Step 5b — release queue will fire" \
		|| echo "MISSING/MALFORMED Flag: line — Step 4b fired but the body has no matching plain 'Flag: <key>' line; patch it in before stopping (#1282)"
else
	echo "no dark ship (containment=$CONTAINMENT, cycle-doc=$CYCLE_DOC) — no Flag: line expected"
fi
# (e) DISCLOSURE PRESENCE, REST-only: the body carries a `## Deviations` heading. This is the
#     PRESENCE floor only — it cannot tell an honest `None.` from a false one, and it sees none of
#     the seven classes (§DEV's detection tiers). It exists so the one failure mode that is purely
#     mechanical — forgetting the heading — never reaches a gate as a malformed body.
gh api repos/$REPO/pulls/$PR --jq '.body' \
	| grep -Eiq '^[[:space:]]*#{2,3}[[:space:]]*Deviations[[:space:]]*$' \
	&& echo "## Deviations section present" \
	|| echo "MISSING ## Deviations section — an ABSENT section is a gate FAIL (§DEV: absent is not None.); patch the body before stopping"
