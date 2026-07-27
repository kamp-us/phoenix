#!/usr/bin/env bash
# doctor.sh — verify a repo meets the kampus-pipeline prerequisites and print a
# tiered pass/fail checklist with the exact fix command for each gap. The role
# `ctx doctor` plays for context-mode (#460). Pure-ish: it READS repo state via
# `gh`/`npm` and writes nothing — every fix is a command it prints, never runs.
#
# Tiers (a foreign-repo adopter reads top-down):
#   1  load-bearing   — gh auth + the required label vocabulary.
#   2  gating         — repo resolution, a CI signal ship-it can gate on, and the
#                       merge-queue governance ship-it's enqueue silently depends on.
#   3  optional       — `pnpm dlx` packages, the run-evidence producer, the
#                       ideation-layer labels, and an open milestone; their absence
#                       degrades a stage, it does not break the pipeline.
#
# Why the labels are Tier 1 is NOT "the first write errors" — that was measured and is
# false. `POST /repos/{owner}/{repo}/issues/{n}/labels` AUTO-CREATES a missing label
# (observed 2026-07-26: HTTP 200, label materialized repo-wide at GitHub's default grey
# `ededed` with a null description). So `report` silently succeeds and mints an
# off-taxonomy label; the damage lands on the READ side, where `?labels=status:triaged`
# and every guard's label scoping then match nothing and the pipeline runs protecting
# nothing — the silent no-op ADR 0092 exists to kill (#4300).
#
# Every check below reports THREE states, never two: present, absent, and UNDETERMINED
# (the read itself did not succeed). A read that fails must never resolve to "fine" —
# that collapse is what let a green doctor sit on top of an unusable repo.
#
# Exit 0 only when every Tier-1 and Tier-2 check passes; Tier-3 gaps WARN, never fail.
set -uo pipefail

PASS="✓"; FAIL="✗"; WARN="⚠"
fails=0

say()  { printf '  %s %s\n' "$1" "$2"; }
# One-line, length-clamped echo of whatever a read actually returned. A failed `gh api` prints its
# error BODY to stdout, so quoting it back verbatim would smear a multi-line JSON blob across the
# checklist — but dropping it entirely would leave "the read failed" unattributable. Clamp, don't cut.
brief() { printf '%s' "$1" | tr '\n\t' '  ' | cut -c1-120; }
fix()  { printf '      ↳ fix: %s\n' "$1"; }
hdr()  { printf '\n%s\n' "$1"; }

REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)}"

printf 'kampus-pipeline doctor — target repo: %s\n' "${REPO:-<unresolved>}"

hdr "Tier 1 — load-bearing (first run fails without these)"

# 1a. gh authenticated
if gh auth status >/dev/null 2>&1; then
	say "$PASS" "gh CLI authenticated"
else
	say "$FAIL" "gh CLI not authenticated"
	fix "gh auth login"
	fails=$((fails + 1))
fi

# 1b. token carries the `project` scope (the org's Projects-classic integration
#     requires it; it is also why every pipeline call is `gh api` REST, never GraphQL)
SCOPES=$(gh auth status 2>&1 | sed -n 's/.*Token scopes: //p' | tr -d "'")
if printf '%s' "$SCOPES" | grep -q "project"; then
	say "$PASS" "gh token has the 'project' scope"
else
	say "$WARN" "gh token may lack the 'project' scope (needed for Projects-classic)"
	fix "gh auth refresh -s project"
fi

# 1c. the label vocabulary exists in the target repo, as NAME|TIER|HEX|DESCRIPTION rows fed
#     to the loop from a heredoc (a `|`-delimited heredoc, not $(cat <<…) — the latter
#     mis-parses under bash 3.2, the macOS default). TIER 1 rows are required and fail the
#     run; TIER 3 rows are ideation-layer and only ever WARN, reported down in Tier 3.
#
#     This table is a PRESENTATION mirror (it carries the colour + description the create
#     commands need, which the source has no room for), NOT a second required-set: check 1d
#     asserts it covers the shared vocabulary in `packages/pipeline-cli/src/tools/
#     vocabulary-preflight/vocabulary.ts`, which assembles the set from the constants the
#     guards themselves scope on. Add a Tier-1 row here only alongside that source (#4272);
#     the homing labels it must cover are ruled in ../triage/SKILL.md Step 6.
#
#     Read the universe with the outcome SEPARATED from the content: a failed read leaves
#     the same empty string a genuinely label-less repo does, and scoring absence off it
#     would name every required label "missing" on what is really an auth or network fault.
EXISTING=""
labels_read=no-repo
if [ -n "${REPO:-}" ]; then
	if EXISTING=$(gh api "repos/$REPO/labels?per_page=100" --jq '.[].name' 2>/dev/null); then
		labels_read=ok
	else
		labels_read=failed
	fi
fi

required_total=0
missing_required=0
required_fixes=""
REQUIRED_NAMES=""
optional_missing=0
optional_fixes=""
while IFS='|' read -r name tier color desc; do
	[ -z "$name" ] && continue
	if [ "$tier" = "1" ]; then
		required_total=$((required_total + 1))
		REQUIRED_NAMES="$REQUIRED_NAMES$name
"
	fi
	[ "$labels_read" = "ok" ] || continue # UNDETERMINED: never score absence off a read that failed
	printf '%s\n' "$EXISTING" | grep -Fxq "$name" && continue
	CREATE="gh label create \"$name\" --repo \"$REPO\" --color \"$color\" --description \"$desc\""
	if [ "$tier" = "1" ]; then
		missing_required=$((missing_required + 1))
		required_fixes="$required_fixes$CREATE
"
	else
		optional_missing=$((optional_missing + 1))
		optional_fixes="$optional_fixes$CREATE
"
	fi
done <<'LABELS'
status:needs-triage|1|fbca04|Filed, awaiting triage classification
status:needs-info|1|fbca04|Human-filed; awaiting answers before triage
status:planned|1|fbca04|plan-epic child: planned, not yet verified by review-plan, not pickable
status:triaged|1|fbca04|Triage signed off; ready for write-code to pick
status:planning|1|fbca04|Epic-lock held: a plan-epic/review-plan run is mutating this epic's children (ADR 0059)
status:awaiting-release|1|5319e7|Post-merge release-queue marker: deployed dark, awaiting a human flag flip (ADR 0083).
type:bug|1|1d76db|Behavior diverges from intent
type:chore|1|1d76db|No behavior change
type:decision|1|1d76db|One question; output is a recorded choice
type:epic|1|1d76db|Too big for one PR; spawns children
type:feature|1|1d76db|New capability, directly implementable
type:investigation|1|1d76db|Unknown; output is knowledge
p0|1|b60205|Highest priority
p1|1|d93f0b|Medium priority
p2|1|e99695|Lowest priority
wayfinder:backlog|1|8250df|Standing lane: a destination queued for a wayfinding chart (triage's standing-lane exemption)
axis:pipeline-hardening|1|5319e7|Standing lane: the cross-cutting pipeline-hardening axis (triage's standing-lane exemption)
area:infra|1|0e8a16|Platform/infra discriminator the lane tool scopes on
wayfinder:map|3|8250df|Ideation-layer map issue — the wayfinder chart front door (issue-shape marker, not a type)
LABELS

if [ "$labels_read" = "no-repo" ]; then
	say "$FAIL" "required labels UNDETERMINED — the target repo never resolved, so the label universe was never read (unknown, NOT absent)"
	fix "set CLAUDE_PIPELINE_REPO=owner/name, or run inside the target git repo, then re-run"
	fails=$((fails + 1))
elif [ "$labels_read" = "failed" ]; then
	say "$FAIL" "required labels UNDETERMINED — the label read on $REPO FAILED (unknown, NOT absent; likely auth, permissions, or network)"
	fix "gh auth status && gh api \"repos/$REPO/labels?per_page=100\"  # make the read succeed, then re-run"
	fails=$((fails + 1))
elif [ "$missing_required" -eq 0 ]; then
	say "$PASS" "all $required_total required pipeline labels exist"
else
	say "$FAIL" "$missing_required of $required_total required pipeline label(s) absent"
	printf '%s' "$required_fixes" | while IFS= read -r line; do
		[ -n "$line" ] && fix "$line"
	done
	fails=$((fails + 1))
fi

# 1d. doctor's Tier-1 rows still cover the shared vocabulary. The set the guards scope on
#     lives in ONE place and is assembled from their own constants; this asserts the table
#     above has not fallen behind it — the drift that let doctor green a repo where triage
#     had no non-kill home (#4300). Reads it through the CLI shim, the only seam a bash
#     preflight has onto a TS constant.
PCLI="$(cd "$(dirname "$0")/../../bin" 2>/dev/null && pwd)/pipeline-cli"
SHARED=""
shared_read=unresolved
if [ -x "$PCLI" ]; then
	if SHARED=$("$PCLI" vocabulary-preflight labels 2>/dev/null) && [ -n "$SHARED" ]; then
		shared_read=ok
	fi
fi

shared_total=0
drifted=""
if [ "$shared_read" = "ok" ]; then
	while IFS= read -r want; do
		[ -z "$want" ] && continue
		shared_total=$((shared_total + 1))
		printf '%s\n' "$REQUIRED_NAMES" | grep -Fxq "$want" && continue
		drifted="$drifted $want"
	done <<SHARED_SET
$SHARED
SHARED_SET
fi

if [ "$shared_read" != "ok" ]; then
	# WARN, not FAIL: an adopter without the CLI resolved still gets every check above. What is
	# lost is only the confirmation, and saying so beats claiming a verification that never ran.
	say "$WARN" "doctor's required set is UNVERIFIED against the shared vocabulary — could not resolve it (unknown, NOT confirmed)"
	fix "run from a checkout with packages/pipeline-cli, or make \`pipeline-cli vocabulary-preflight labels\` resolvable"
elif [ -n "$drifted" ]; then
	say "$FAIL" "doctor's required set has DRIFTED from the shared vocabulary — absent from the table above:$drifted"
	fix "add each label above to the LABELS table in this file as a tier-1 row (name|1|hex|description)"
	fails=$((fails + 1))
else
	say "$PASS" "doctor's required set covers all $shared_total labels of the shared vocabulary"
fi

hdr "Tier 2 — gating (a stage fails deep without these)"

# 2a. target repo resolves
if [ -n "${REPO:-}" ]; then
	say "$PASS" "target repo resolves ($REPO)"
else
	say "$FAIL" "target repo does not resolve"
	fix "set CLAUDE_PIPELINE_REPO=owner/name, or run inside the target git repo with an 'origin' remote"
	fails=$((fails + 1))
fi

# 2b. a CI signal exists for ship-it to gate on (Step 3 reads check-runs green).
#     Three outcomes, per the read discipline the Tier-2 governance checks below state in full:
#     the retired `|| echo 0` APPENDED to gh's un-`--jq`'d error body rather than replacing it, so
#     an unreadable repo produced `{"message":"Not Found",…}0`, tripped `[: integer expression
#     expected`, and landed on "no CI workflows defined" — a failed read reported as the negative
#     answer (#4347).
WORKFLOWS=""
WF_RC=1
if [ -n "${REPO:-}" ]; then
	WORKFLOWS=$(gh api "repos/$REPO/actions/workflows" --jq '.total_count' 2>/dev/null)
	WF_RC=$?
fi
if [ "$WF_RC" -ne 0 ] || ! printf '%s' "$WORKFLOWS" | grep -Eq '^[0-9]+$'; then
	say "$FAIL" "READ FAILED: could not read the workflows of ${REPO:-<unresolved repo>} (gh exit $WF_RC, returned: $(brief "${WORKFLOWS:-<empty>}")) — the workflow count is UNKNOWN, which is neither a pass nor 'no CI workflows'"
	fix "resolve the repo and re-run once \`gh auth status\` shows a token that can read it — this line says NOTHING about whether CI exists, so do not add a workflow on the strength of it"
	fails=$((fails + 1))
elif [ "$WORKFLOWS" -gt 0 ]; then
	say "$PASS" "CI workflows defined ($WORKFLOWS) — ship-it has a checks-green signal to gate on"
else
	say "$FAIL" "no CI workflows defined — ship-it's checks-green gate (Step 3) passes vacuously"
	fix "add at least one GitHub Actions workflow that produces a required check (lint/test/typecheck)"
	fails=$((fails + 1))
fi

# 2c/2d. the merge-queue governance regime ship-it's enqueue depends on. `gh pr merge $PR --auto`
#        passes NO merge-method flag because the queue owns the method (ADR 0132), so it works only
#        when the repo carries BOTH `allow_auto_merge` AND a default-branch ruleset with a
#        `merge_queue` rule. Neither is expressible in-repo and neither can be created by a
#        repo-scoped script — and both fail at the LAST step of a first run: an adopter builds,
#        reviews, approves, enqueues, and the merge never lands (#4303). Read them here so the gap
#        surfaces before the work, not after it.
#
#        Read discipline for both (§ZS, ADR 0092): an unreadable response is UNKNOWN — never a pass,
#        and never reported as the negative answer. `gh api` writes its error body to stdout WITHOUT
#        applying `--jq`, so an unguarded capture reads the error as data (#4223); each read below
#        therefore keeps gh's exit status and admits only the literal values it expects.
ADR0132="https://github.com/kamp-us/phoenix/blob/main/.decisions/0132-merge-queue-for-base-freshness.md"

# `allow_auto_merge` is an ADMIN-VISIBLE field: on a repo the token lacks admin on, GitHub
# omits the key entirely and `gh api --jq` then exits 0 printing NOTHING (measured against a
# public repo). "Absent" is therefore indistinguishable from "false" if you only look at the
# value — which is why the pass arm below demands the literal `true` and everything that is
# not literally `true`/`false` resolves UNKNOWN rather than borrowing the negative answer.
AUTO_MERGE=""
AM_RC=1
if [ -n "${REPO:-}" ]; then
	AUTO_MERGE=$(gh api "repos/$REPO" --jq '.allow_auto_merge' 2>/dev/null)
	AM_RC=$?
fi
if [ "$AM_RC" -eq 0 ] && [ "$AUTO_MERGE" = "true" ]; then
	say "$PASS" "repo-level auto-merge enabled (allow_auto_merge) — ship-it's --auto enqueue can arm"
elif [ "$AM_RC" -eq 0 ] && [ "$AUTO_MERGE" = "false" ]; then
	say "$FAIL" "MISSING PRECONDITION: repo-level auto-merge is disabled (allow_auto_merge=false) — ship-it's enqueue fails with 'Auto merge is not allowed for this repository (enablePullRequestAutoMerge)'. Why: ADR 0132 §Addendum §1"
	fix "gh api -X PATCH \"repos/$REPO\" -F allow_auto_merge=true    # repo-admin only, or Settings → General → Pull Requests → Allow auto-merge — $ADR0132"
	fails=$((fails + 1))
else
	say "$FAIL" "READ FAILED: could not read allow_auto_merge on ${REPO:-<unresolved repo>} (gh exit $AM_RC, returned: $(brief "${AUTO_MERGE:-<empty>}")) — UNKNOWN, which is neither a pass nor 'disabled'"
	fix "re-run with a token holding ADMIN on ${REPO:-the target repo} — GitHub omits allow_auto_merge for non-admins, so its state cannot be read (let alone asserted) from here. Why it matters: ADR 0132 §Addendum §1 — $ADR0132"
	fails=$((fails + 1))
fi

# The queue rule is read for the repo's RESOLVED default branch — never a hardcoded `main`: an
# adopter's default branch is theirs to name, and asserting the rule on a branch they don't have
# would red for the wrong reason. Endpoint + rule shape reused from the merge-intent reader
# (packages/pipeline-cli/src/tools/merge-intent/github.ts): a ruleset-governed repo 404s on
# `branches/<b>/protection`, so `rules/branches/<b>` is what answers this.
DEFAULT_BRANCH=""
DB_RC=1
if [ -n "${REPO:-}" ]; then
	DEFAULT_BRANCH=$(gh api "repos/$REPO" --jq '.default_branch' 2>/dev/null)
	DB_RC=$?
fi
if [ "$DB_RC" -ne 0 ] || [ -z "$DEFAULT_BRANCH" ] || [ "$DEFAULT_BRANCH" = "null" ]; then
	say "$FAIL" "READ FAILED: could not resolve the default branch of ${REPO:-<unresolved repo>} (gh exit $DB_RC, returned: $(brief "${DEFAULT_BRANCH:-<empty>}")) — the merge-queue rule check has no branch to ask about, so its state is UNKNOWN, not a pass"
	fix "re-run once the repo resolves and \`gh auth status\` shows a token that can read it — then re-read ADR 0132 §Consequences: $ADR0132"
	fails=$((fails + 1))
else
	# A default branch may legitimately contain '/' (e.g. `release/main`); percent-encode it so it
	# stays ONE path segment instead of splitting the REST route.
	BRANCH_PATH=$(printf '%s' "$DEFAULT_BRANCH" | sed 's|/|%2F|g')
	MQ=$(gh api "repos/$REPO/rules/branches/$BRANCH_PATH" --jq '[.[] | select(.type == "merge_queue")] | length' 2>/dev/null)
	MQ_RC=$?
	if [ "$MQ_RC" -ne 0 ] || ! printf '%s' "$MQ" | grep -Eq '^[0-9]+$'; then
		say "$FAIL" "READ FAILED: could not read the rules applying to default branch '$DEFAULT_BRANCH' (gh exit $MQ_RC, returned: $(brief "${MQ:-<empty>}")) — UNKNOWN, which is neither a pass nor 'no merge queue'"
		fix "re-run once \`gh api \"repos/$REPO/rules/branches/$BRANCH_PATH\"\` reads cleanly — then re-read ADR 0132 §Consequences: $ADR0132"
		fails=$((fails + 1))
	elif [ "$MQ" -gt 0 ]; then
		say "$PASS" "default branch '$DEFAULT_BRANCH' is merge-queue governed (a merge_queue rule applies) — the queue supplies ship-it's merge method"
	else
		say "$FAIL" "MISSING PRECONDITION: no merge_queue rule applies to default branch '$DEFAULT_BRANCH' — ship-it enqueues with no merge method and the merge never lands. Why: ADR 0132 §Consequences"
		fix "repo-admin, human-only: Settings → Rules → Rulesets → a ruleset targeting '$DEFAULT_BRANCH' → enable 'Require merge queue' (merge method SQUASH). ADR 0132 §Consequences calls this the separate, last, human-only administrative step — $ADR0132"
		fails=$((fails + 1))
	fi
fi

hdr "Tier 3 — optional (degrades a stage; pipeline still runs)"

# 3a. the consolidated `pnpm dlx` package adr / review-plan reach for (epic #994:
# decisions-index + epic-ledger now ship as tools inside @kampus/pipeline-cli)
for pkg in @kampus/pipeline-cli; do
	if npm view "$pkg" version >/dev/null 2>&1; then
		say "$PASS" "$pkg resolves on the npm registry (provides decisions-index / epic-ledger)"
	else
		say "$WARN" "$pkg does not resolve — adr/review-plan run degraded"
		fix "publish $pkg, or vendor it; see ADR 0062 §3"
	fi
done

# 3b. the run-evidence producer (ship-it degrades gracefully without it — ADR 0086).
#     Same three-outcome read discipline as 2b/2c/2d; WARN-only in all three arms, so the
#     undetermined arm still never touches `fails` (#4347).
RUNEV=""
RE_RC=1
if [ -n "${REPO:-}" ]; then
	# No --paginate: with --paginate, gh feeds each page to --jq separately, so `| length`
	# prints one integer PER PAGE (a multi-line "0\n0" that breaks the -gt test). per_page=100
	# fits any realistic repo's workflow set in one page → a single integer.
	RUNEV=$(gh api "repos/$REPO/actions/workflows?per_page=100" \
		--jq '[.workflows[] | select(.name=="run-evidence")] | length' 2>/dev/null)
	RE_RC=$?
fi
if [ "$RE_RC" -ne 0 ] || ! printf '%s' "$RUNEV" | grep -Eq '^[0-9]+$'; then
	say "$WARN" "READ FAILED: could not read the workflows of ${REPO:-<unresolved repo>} (gh exit $RE_RC, returned: $(brief "${RUNEV:-<empty>}")) — whether a run-evidence producer exists is UNKNOWN, which is neither a pass nor 'no run-evidence producer'"
	fix "resolve the repo and re-run once \`gh auth status\` shows a token that can read it — ship-it guard 2's mode stays undetermined until this read succeeds"
elif [ "$RUNEV" -gt 0 ]; then
	say "$PASS" "run-evidence producer present — ship-it guard 2 runs in strict mode"
else
	say "$WARN" "no run-evidence producer — ship-it guard 2 degrades to checks-green (ADR 0086)"
	fix "optional: ship .github/workflows/run-evidence.yml + packages/pipeline-cli/src/tools/crabbox-manifest for SHA-bound evidence"
fi

# 3c. the ideation-layer labels (the tier-3 rows of the table above). `wayfinder` keys its map
#     issue on one; absent, that surface degrades — it does not block a first run.
if [ "$labels_read" != "ok" ]; then
	say "$WARN" "ideation-layer labels UNDETERMINED — the label read did not succeed (see Tier 1)"
elif [ "$optional_missing" -eq 0 ]; then
	say "$PASS" "ideation-layer labels present — the wayfinder map surface is usable"
else
	say "$WARN" "$optional_missing ideation-layer label(s) absent — the wayfinder map surface degrades"
	printf '%s' "$optional_fixes" | while IFS= read -r line; do
		[ -n "$line" ] && fix "$line"
	done
fi

# 3d. an OPEN milestone exists — triage's arc/campaign home. Deliberately not Tier 1: a freshly
#     adopted repo legitimately has none, and creating one is a human roadmap act triage is
#     forbidden from doing for itself (ADR 0072 §3), so reddening here would fail the correct
#     state of a brand-new adopter.
MILESTONES=""
ms_read=unknown
if [ -n "${REPO:-}" ]; then
	if MILESTONES=$(gh api "repos/$REPO/milestones?state=open&per_page=100" --jq 'length' 2>/dev/null); then
		ms_read=ok
	fi
fi

if [ "$ms_read" != "ok" ]; then
	say "$WARN" "open-milestone existence UNDETERMINED — the read did not succeed (unknown, NOT 'no milestone')"
	fix "gh api \"repos/$REPO/milestones?state=open\"  # make the read succeed, then re-run"
elif [ "${MILESTONES:-0}" -gt 0 ]; then
	say "$PASS" "$MILESTONES open milestone(s) — triage can home an issue into an arc/campaign"
else
	say "$WARN" "no open milestone — triage can exempt an issue to a standing lane, but cannot home one into an arc/campaign"
	fix "a human creates the first arc/campaign milestone (triage never does): gh api -X POST \"repos/$REPO/milestones\" -f title=\"<arc name>\""
fi

hdr "Verdict"
if [ "$fails" -eq 0 ]; then
	printf '  %s pipeline-ready: all Tier-1 and Tier-2 checks passed.\n' "$PASS"
	exit 0
fi
printf '  %s not pipeline-ready: %d blocking check(s) failed — apply the fixes above and re-run.\n' "$FAIL" "$fails"
exit 1
