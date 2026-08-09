#!/usr/bin/env bash
# Step 3c — the glossary-freshness gate: the three new-surface detectors, the positive-evidence-of-scope
# probe, and the four-outcome verdict chain. Extracted from review-code/SKILL.md (#4451, epic #4435
# phase 1) — blocks 18 and 19 land in ONE script because the chain consumes the detectors' variables,
# which no longer survive as shell state across two fenced blocks. Extraction contract:
# ../SKILL.md § The extracted scripts. The *why* for each outcome stays in that step's prose.
#
# Prints exactly one `glossary-freshness: …` line. The two `not applicable` lines are the SKIP answers,
# so a run that could not evaluate must never print one: every early exit prints
# `glossary-freshness: CANNOT-EVALUATE (…)` and exits non-zero, which the caller folds as an
# `[UNVERIFIABLE]` row — the same blocking soft-fail the detector-blind branch yields. An absent or
# empty result is UNKNOWN, and UNKNOWN is never a skip (§ZS / ADR 0092; #4299).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

cannot() { echo "glossary-freshness: CANNOT-EVALUATE ($1) — fold as [UNVERIFIABLE], never as a not-applicable skip (§ZS, #4299)"; exit "${2:-1}"; }

[ "$#" -ge 1 ] || { echo "usage: glossary-freshness.sh <pr>" >&2; cannot "no <pr> argument" 2; }
PR="$1"
REPO="$(kp_repo)" || cannot "target repo unresolved"
# BASE_REF comes from the head handle materialize-head.sh wrote — the FRESHLY FETCHED base every
# existence probe below reads against, never the working tree (formats §RO; the PR #305 false-FAIL).
# shellcheck disable=SC1007,SC1090
. "$("$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/head-env.sh")" || cannot "no head handle — run materialize-head.sh first (its \`git fetch origin \$BASE_REF\` is what makes these probes fresh)"
[ -n "${BASE_REF:-}" ] || cannot "handle carries no BASE_REF"

# `git cat-file -e` exits non-zero for BOTH "no such path" and "the read itself failed", so against an
# unreadable base every probe below reads ABSENT and the graceful-absence branch prints a confident
# skip about a base it never saw (#4986). This one assert is what makes a later non-zero probe mean
# absence and nothing else.
git cat-file -e "origin/$BASE_REF^{tree}" 2>/dev/null || cannot "the base tree origin/$BASE_REF is unreadable — every path probe below would then read ABSENT, and 'I could not read the base' is UNKNOWN, never 'this repo has no .glossary/TERMS.md'"

# the file list WITH status (Step 2 already loaded the diff; this reuses the same files endpoint)
# --paginate + streaming --jq so the full set past file #100 is seen (the API caps per_page at 100; #725)
FILES_STATUS="$(gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" \
  --jq '.[] | "\(.status)\t\(.filename)"')"
FILES_RC=$?
[ "$FILES_RC" -eq 0 ] || cannot "the PR file list could not be read (gh api exited $FILES_RC) — detectors (1) and (2) would then scan an EMPTY file set and report no new surface"
# A status test only catches the read that DIED; a read that exits 0 with no rows leaves detectors (1)
# and (2) scanning an empty set and lands on the same clean skip (#4986).
[ -n "$(printf '%s' "$FILES_STATUS" | tr -d '[:space:]')" ] || cannot "the PR file list came back EMPTY at exit 0 — a PR always touches at least one file, so an empty list is ZERO SCOPE, never 'this PR added no new surface'"
ADDED="$(printf '%s\n' "$FILES_STATUS" | awk -F'\t' '$1=="added"{print $2}')"

# (1) a NEW feature folder: an added file under apps/web/worker/features/<dir>/... whose <dir>
#     did not exist on fresh base. Dedupe to the folder; a folder is new iff base has no tree there.
NEW_FEATURE_DIRS=""
for d in $(printf '%s\n' "$ADDED" \
            | sed -nE 's#^(apps/web/worker/features/[^/]+)/.*#\1#p' | sort -u); do
  # read-only existence probe against FRESH base — never the working tree (formats §RO)
  git cat-file -e "origin/$BASE_REF:$d" 2>/dev/null || NEW_FEATURE_DIRS="$NEW_FEATURE_DIRS $d"
done

# (2) a NEW public package: an added packages/<pkg>/package.json whose package dir is absent on base
NEW_PACKAGES=""
for p in $(printf '%s\n' "$ADDED" \
            | sed -nE 's#^(packages/[^/]+)/package\.json$#\1#p' | sort -u); do
  git cat-file -e "origin/$BASE_REF:$p/package.json" 2>/dev/null || NEW_PACKAGES="$NEW_PACKAGES $p"
done

# A new public EXPORT from an existing package is the third surface — a public entry point
# (packages/<pkg>/src/index.ts, or the file a package.json "exports"/"main" names) that the diff
# CHANGES to expose a new name. This one is read from the diff hunk, not a path-status test:
# inspect the diff of any touched public entry for an added `export …` line. Treat a public-entry
# file with an added export as a new surface for this gate.
#
# Both patterns are awk STRINGS matched with `~`, never `/…/` regex literals, so the `/` inside a
# bracket expression can never close the literal that contains it. The literal form is what left
# this detector born-dead from the day it shipped: awk refused to compile `[^/]` inside `/…/`, exited
# 2 into a status nobody tested, and the gate printed its clean skip for six weeks (#4700). `\b` is
# gone for a second, independent reason found while fixing that one — one-true-awk (the macOS `awk
# version 20200816` this gate runs on) does not implement it, so `\bexport\b` matched nothing even
# with the class repaired; the explicit non-word-character alternation is the boundary instead.
# SC2016 is declared, not waved off: this is LITERAL awk text, and shell-expanding its `$0` would
# destroy the program. It is re-expanded nowhere — `awk "$DETECTOR3_AWK"` expands the variable, not
# the `$0` inside its value.
# shellcheck disable=SC2016
DETECTOR3_AWK='
BEGIN {
  entry = "^\\+\\+\\+ b/packages/[^/]+/src/index\\.(ts|tsx)$"
  expre = "(^|[^A-Za-z0-9_$])export([^A-Za-z0-9_$]|$)"
}
$0 ~ entry { in_entry = 1; next }
/^\+\+\+ / { in_entry = 0; next }
in_entry && /^\+/ && $0 ~ expre { print }
'
# Fetch and filter are read SEPARATELY on purpose: piped together, an empty diff at exit 0 is
# indistinguishable from awk matching nothing in a real diff — the second is a fact about the PR, the
# first is UNKNOWN (#4986).
DETECTOR3_DIFF="$(gh pr diff "$PR")"
DETECTOR3_RC=$?
[ "$DETECTOR3_RC" -eq 0 ] || cannot "detector (3), the new-public-export scan, could not run — 'gh pr diff' exited $DETECTOR3_RC; an unrun detector is UNKNOWN, never 'this PR added no export'"
[ -n "$(printf '%s' "$DETECTOR3_DIFF" | tr -d '[:space:]')" ] || cannot "detector (3) got an EMPTY diff at exit 0 — the file list above is non-empty, so a PR with no diff text is ZERO SCOPE, never 'this PR added no export'"
PUBLIC_ENTRY_EXPORT_ADDED="$(printf '%s\n' "$DETECTOR3_DIFF" | awk "$DETECTOR3_AWK")"
DETECTOR3_AWK_RC=$?
[ "$DETECTOR3_AWK_RC" -eq 0 ] || cannot "detector (3), the new-public-export scan, could not run — awk exited $DETECTOR3_AWK_RC; an unrun detector is UNKNOWN, never 'this PR added no export'"

# the union: is there ANY new surface?
NEW_SURFACE="$(printf '%s %s %s' "$NEW_FEATURE_DIRS" "$NEW_PACKAGES" "$PUBLIC_ENTRY_EXPORT_ADDED" | tr -s ' ')"

# does the PR touch the glossary's domain-noun file? (added OR modified — any touch counts)
GLOSSARY_TOUCHED="$(printf '%s\n' "$FILES_STATUS" | awk -F'\t' '$2==".glossary/TERMS.md"{print}')"

# POSITIVE EVIDENCE OF SCOPE (§ZS / ADR 0092's "default FAIL, pass on positive evidence"): can the
# three detectors above express ANYTHING in this repo at all? An empty $NEW_SURFACE has two causes —
# "this PR added no surface" (a fact about the PR) and "this repo has no surface of the kind I know
# how to look for" (a fact about the DETECTOR) — and until this probe they produced the identical
# not-applicable line (#4299). Read-only, against fresh base, same as every probe above.
DETECTOR_SURFACES="$(
  git ls-tree --name-only "origin/$BASE_REF:apps/web/worker/features" 2>/dev/null
  git ls-tree -r --name-only "origin/$BASE_REF:packages" 2>/dev/null | grep -E '^[^/]+/package\.json$'
)"
DETECTOR_SURFACES_N="$(printf '%s\n' "$DETECTOR_SURFACES" | grep -c . || true)"

# The graceful-absence probe LEADS the chain, EXECUTED — never asserted in prose. Every branch below
# claims the glossary is on base, so a repo that never adopted it must be excluded by a real test or
# the final `else` states a fact it never checked — the gate's own sin, one branch over (#4299).
if ! git cat-file -e "origin/$BASE_REF:.glossary/TERMS.md" 2>/dev/null; then
  echo "glossary-freshness: not applicable — no .glossary/TERMS.md on base"   # graceful absence: no row
elif [ -n "$(printf '%s' "$NEW_SURFACE" | tr -d ' ')" ]; then
  echo "glossary-freshness: scanned new surfaces ⇒$NEW_SURFACE"   # §ZS #1: emit what it scanned
  if [ -n "$GLOSSARY_TOUCHED" ]; then
    echo "glossary-freshness: PASS — new surface ships with a .glossary/TERMS.md touch"
  else
    echo "glossary-freshness: FAIL — new surface added but .glossary/TERMS.md untouched (§ZS relevant-but-zero-match)"
    # fold as a FAIL facet in the verdict table (and/or append the in-scope AC per the §2 surface)
  fi
elif [ "$DETECTOR_SURFACES_N" -gt 0 ]; then
  echo "glossary-freshness: not applicable — no new feature folder / public package / export in this PR (detector expressible here: $DETECTOR_SURFACES_N candidate surface(s) on base)"   # §ZS #3 skip
else
  echo "glossary-freshness: UNVERIFIABLE — detector blind: .glossary/TERMS.md is on origin/$BASE_REF, but this repo has ZERO surfaces the detector can express (no apps/web/worker/features/* dir, no packages/*/package.json on base). The empty scan is a fact about the DETECTOR, not this PR — it is NOT evidence the PR added no surface."
  # fold as an [UNVERIFIABLE] facet in the verdict table — a blocking soft fail, never an omitted row
fi
