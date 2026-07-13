#!/usr/bin/env bash
# doctor.sh — verify a repo meets the kampus-pipeline prerequisites and print a
# tiered pass/fail checklist with the exact fix command for each gap. The role
# `ctx doctor` plays for context-mode (#460). Pure-ish: it READS repo state via
# `gh`/`npm` and writes nothing — every fix is a command it prints, never runs.
#
# Tiers (a foreign-repo adopter reads top-down):
#   1  load-bearing   — gh auth + required labels. Without these the first
#                       report/triage run fails deep inside a `gh api` call.
#   2  gating         — repo resolution + a CI signal ship-it can gate on.
#   3  optional       — `pnpm dlx` packages + the run-evidence producer; their
#                       absence degrades a stage, it does not break the pipeline.
#
# Exit 0 only when every Tier-1 and Tier-2 check passes; Tier-3 gaps WARN, never fail.
set -uo pipefail

PASS="✓"; FAIL="✗"; WARN="⚠"
fails=0

say()  { printf '  %s %s\n' "$1" "$2"; }
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

# 1c. required labels exist. The canonical set the intake skills key on (status:*
#     spine, type:* class, p* priority), as NAME|HEX|DESCRIPTION rows fed to the
#     loop from a heredoc (a `|`-delimited heredoc, not $(cat <<…) — the latter
#     mis-parses under bash 3.2, the macOS default).
EXISTING=""
if [ -n "${REPO:-}" ]; then
	EXISTING=$(gh api "repos/$REPO/labels?per_page=100" --jq '.[].name' 2>/dev/null)
fi

missing=0
while IFS='|' read -r name color desc; do
	[ -z "$name" ] && continue
	if printf '%s\n' "$EXISTING" | grep -Fxq "$name"; then
		continue
	fi
	missing=$((missing + 1))
	fix "gh label create \"$name\" --repo \"$REPO\" --color \"$color\" --description \"$desc\""
done <<'LABELS'
status:needs-triage|fbca04|Filed, awaiting triage classification
status:needs-info|fbca04|Human-filed; awaiting answers before triage
status:planned|fbca04|plan-epic child: planned, not yet verified by review-plan, not pickable
status:triaged|fbca04|Triage signed off; ready for write-code to pick
status:planning|fbca04|Epic-lock held: a plan-epic/review-plan run is mutating this epic's children (ADR 0059)
status:awaiting-release|5319e7|Post-merge release-queue marker: deployed dark, awaiting a human flag flip (ADR 0083).
type:bug|1d76db|Behavior diverges from intent
type:chore|1d76db|No behavior change
type:decision|1d76db|One question; output is a recorded choice
type:epic|1d76db|Too big for one PR; spawns children
type:feature|1d76db|New capability, directly implementable
type:investigation|1d76db|Unknown; output is knowledge
p0|b60205|Highest priority
p1|d93f0b|Medium priority
p2|e99695|Lowest priority
LABELS

if [ "$missing" -eq 0 ] && [ -n "$EXISTING" ]; then
	say "$PASS" "all 15 required pipeline labels exist"
elif [ -z "$EXISTING" ]; then
	say "$FAIL" "could not read repo labels (repo unresolved or gh unauthenticated) — run the fixes above first"
	fails=$((fails + 1))
else
	say "$FAIL" "$missing required pipeline label(s) missing (create commands above)"
	fails=$((fails + 1))
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

# 2b. a CI signal exists for ship-it to gate on (Step 3 reads check-runs green)
WORKFLOWS=0
if [ -n "${REPO:-}" ]; then
	WORKFLOWS=$(gh api "repos/$REPO/actions/workflows" --jq '.total_count' 2>/dev/null || echo 0)
fi
if [ "${WORKFLOWS:-0}" -gt 0 ]; then
	say "$PASS" "CI workflows defined ($WORKFLOWS) — ship-it has a checks-green signal to gate on"
else
	say "$FAIL" "no CI workflows defined — ship-it's checks-green gate (Step 3) passes vacuously"
	fix "add at least one GitHub Actions workflow that produces a required check (lint/test/typecheck)"
	fails=$((fails + 1))
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

# 3b. the run-evidence producer (ship-it degrades gracefully without it — ADR 0086)
RUNEV=0
if [ -n "${REPO:-}" ]; then
	# No --paginate: with --paginate, gh feeds each page to --jq separately, so `| length`
	# prints one integer PER PAGE (a multi-line "0\n0" that breaks the -gt test). per_page=100
	# fits any realistic repo's workflow set in one page → a single integer.
	RUNEV=$(gh api "repos/$REPO/actions/workflows?per_page=100" \
		--jq '[.workflows[] | select(.name=="run-evidence")] | length' 2>/dev/null || echo 0)
fi
if [ "${RUNEV:-0}" -gt 0 ]; then
	say "$PASS" "run-evidence producer present — ship-it guard 2 runs in strict mode"
else
	say "$WARN" "no run-evidence producer — ship-it guard 2 degrades to checks-green (ADR 0086)"
	fix "optional: ship .github/workflows/run-evidence.yml + packages/pipeline-cli/src/tools/crabbox-manifest for SHA-bound evidence"
fi

hdr "Verdict"
if [ "$fails" -eq 0 ]; then
	printf '  %s pipeline-ready: all Tier-1 and Tier-2 checks passed.\n' "$PASS"
	exit 0
fi
printf '  %s not pipeline-ready: %d blocking check(s) failed — apply the fixes above and re-run.\n' "$FAIL" "$fails"
exit 1
