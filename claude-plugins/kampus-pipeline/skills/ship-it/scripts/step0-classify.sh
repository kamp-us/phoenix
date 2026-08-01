#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091
# Classify the diff: the §CP derivation, the artifact-class probes, and the additive UI probe.
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 0 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step0-classify.sh <REPO> <PR>
#              stdout is a PROSE answer channel, exactly as the fence's was: `CP_STATE=<state>`, then
#              one `BLOCKING (…)` line per §CP finding, then one class word per class present
#              (`has-skills` / `has-code` / `has-docs`) and `has-ui` when the diff renders a surface.
#              The ordinary §CP answer is the ABSENCE of a BLOCKING line, so read `CP_STATE=` as the
#              evidence the derivation ran — never emptiness. A classification that could not be made
#              prints `STOP: …` and exits 1.
#   SOURCED:   `verify-chain-resolves.sh` check 2 stands this file up against a stubbed `gh` /
#              `pipeline-cli`, reading $REPO and $PR out of its own driver shell. Untouched.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
# §CPREAD's `cp_changed_files` / `cp_head_sha`, sourced IN-CHAIN from their canonical home — the
# extraction dropped this line and left both calls below command-not-found (#4547). Same idiom as
# review-code's `classify-control-plane.sh`; never a re-copy of the helpers.
# shellcheck source=../../shared/scripts/cp-read.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/cp-read.sh"

REPO="${REPO:-${1:?step0-classify.sh: REPO unset and no \$1 — refusing to classify a diff in an unnamed repo}}"
PR="${PR:-${2:?step0-classify.sh: PR unset and no \$2 — refusing to classify an unnamed PR}}"

# The changed-file list is a fallible network READ, and EVERY probe in this step — §CP, the ADR
# content clause, has-code/has-docs/has-skills, has-ui — is a `grep` over it. So a failed read used
# to answer "no §CP path, no classes present" in one stroke: the capture's exit status was never
# checked, and an empty $FILES made every `grep -q … && echo …` silent (#4216). `cp_changed_files` is
# §CPREAD of ../gh-issue-intake-formats.md (and `cp_head_sha`, used by the content clause below, is
# its companion), both sourced in-chain above (single source; the why lives there, not here). --paginate + streaming --jq inside it gets the full set past file #100 (the
# API caps per_page at 100; the grep probes below aggregate the concatenated lines) (#725).
if ! cp_changed_files "$REPO" "$PR"; then
  # FAIL CLOSED, and STOP — with no file list there is no classification to make: not §CP, not the
  # class set, not has-ui. Emitting BLOCKING is the safe resolution of the §CP axis (this step's
  # output is what the Routing below refuses on), but the class axis is UNRESOLVED, not empty, so
  # ship-it must not proceed to require zero gates.
  echo "BLOCKING (changed-file list unreadable ⇒ §CP UNKNOWN, held — ADR 0092 §ZS, #4216)"
  echo "STOP: classification unresolved — refuse to enqueue and report the failed read; do NOT read this as 'no gates required'."
  exit 1
fi
FILES="$CP_FILES"   # proven-arrived, scope already emitted ($CP_FILES_N files) per §ZS #1
# NON-TRIVIALITY ASSERT (#4401) — single-sourced in §CLASS of gh-issue-intake-formats.md; copied
# here verbatim because Step 0 runs as one shell block. EVERY boundary this step strips out of a
# network read goes through it before anything gates on it: an empty or prefix-carrying value still
# COMPILES, and `grep -E ""` matches every path while `grep -Ev ""` matches none, both at exit 0.
accept_re() {   # $1=name, $2=resolved value, $3=fail-closed default
  case "$2" in
    *"$1='"*) : ;;   # the assignment prefix survived the strip ⇒ not a pattern, a whole line
    *) if [ "${#2}" -ge 4 ]; then printf '%s' "$2"; return 0; fi ;;
  esac
  printf 'TRIVIAL-GATE-BOUNDARY: %s did not resolve to a usable pattern — failing closed.\n' "$1" >&2
  printf '%s' "$3"
}
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# Could-not-run is UNKNOWN, never a discharge (§CLI, #3314). The catch-all below would hold an
# unresolvable shim anyway; refusing here names the cause instead of reporting an empty state word.
[ -x "$PCLI" ] || { echo "BLOCKING (CLI shim UNRESOLVED at '$PCLI' ⇒ §CP UNKNOWN, held)"; echo "STOP: classification unresolved — refuse to enqueue."; exit 1; }
# The §CP derivation — the shared verb, not a hand-rolled boundary grep (#4405); the prose above is
# the why. Four states on stdout, only `not-control-plane` an answer: assert on the STATE WORD, never
# the exit status (formats §CP; #4161/#4219).
CP_STATE="$(printf '%s\n' "$FILES" | "$PCLI" cp-classify classify --repo "$REPO")"
# The positive token, so the executed reader never infers the state from an absence — the ordinary
# answer below is the ABSENCE of a BLOCKING line (`.patterns/skill-script-io-contract.md`, #4510).
printf 'CP_STATE=%s\n' "$CP_STATE"
if [ "$CP_STATE" = "control-plane" ]; then
  echo "BLOCKING"   # a path matched the live boundary: .claude/.github + the gate-critical skills (ADR 0065) + the enforcement-guard packages (ADR 0100/0103); other skills/** auto-merge on a review-skill PASS (ADR 0073)
elif [ "$CP_STATE" = "content-undetermined" ]; then
  # Discharge the ADR-0164 obligation with the SAME shared `guard-content-probe` the review gates and
  # the driver (via trivial-diff) run (#3645, founder ruling #3416) — so a guard-touching ADR
  # classifies §CP identically at every stage, not just here. The GUARD_ADR_RE vocabulary stays
  # single-sourced in gh-issue-intake-formats.md §CP.
  # The ref is a fallible read — `cp_head_sha` is §CPREAD's companion to `cp_changed_files` (same
  # in-chain source). It DISCARDS gh's payload on failure, which is what makes the emptiness
  # test below a live guard: with a bare `|| true` the error document lands in HEAD_SHA, non-empty.
  cp_head_sha "$REPO" "$PR"; HEAD_SHA="$CP_HEAD_SHA"
  if [ -z "$HEAD_SHA" ]; then
    echo "BLOCKING (head SHA unreadable ⇒ no ref to probe ADR content at ⇒ §CP UNKNOWN, held)"   # fail closed: an unprobeable content clause is not an absent one
  else
    # The ordinary answer here is a diff that touches NO ADR — i.e. this filter matching nothing.
    # Left inside the pipeline, that no-match exit 1 becomes the pipeline's status under executed
    # mode's `pipefail`. Capture the filter first (`|| true`) and give the loop an `if … fi` body, so
    # neither the filter's nor an empty loop's status can reach this script's
    # (`.patterns/skill-script-shell-shape.md` § The dual-mode shape rule 4).
    TOUCHED_ADRS="$(printf '%s\n' "$FILES" | grep -E '^\.decisions/.*\.md$' || true)"
    printf '%s\n' "$TOUCHED_ADRS" | while IFS= read -r adr; do
      if [ -n "$adr" ]; then
      # Capture and CHECK before classifying, never a straight pipe — gh writes its error document to
      # STDOUT, so a pipe would hand the probe an ERROR BODY as the ADR body (§CPREAD #2, #4216).
      adr_body="$(gh api "repos/$REPO/contents/$adr?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' 2>/dev/null)" || adr_body=""
      # A classification is only as good as the bytes it was derived from: a truncated or near-empty
      # body classifies `not-guard-touching` just as cleanly as a real one, so an unread ADR would
      # pose as a proven-ordinary one. A real ADR's frontmatter alone clears this floor, so the
      # assert can only move an outcome TOWARD §CP.
      if [ "${#adr_body}" -lt 64 ]; then
        echo "BLOCKING ($adr — ADR body unreadable or trivially short (${#adr_body} bytes) ⇒ §CP UNKNOWN, held)"
      else
        # Same state-word rule as cp-classify above. Note `guard-content-probe` takes --body-file /
        # --path and NOT --repo: an unrecognized flag prints HELP TEXT and exits non-zero, which is
        # not a classification. The `*)` arm holds it, exactly as it holds an unreadable body (#4219).
        GC_STATE="$(printf '%s' "$adr_body" | "$PCLI" guard-content-probe classify --path "$adr" 2>/dev/null)"
        case "$GC_STATE" in
          not-guard-touching) : ;;   # proven ordinary — the ONLY value that may skip the §CP hold
          guard-touching) echo "BLOCKING ($adr — guard-touching ADR ⇒ §CP, ADR 0164)" ;;
          *) echo "BLOCKING ($adr — probe UNDETERMINED (state '$GC_STATE') ⇒ §CP, fail-closed)" ;;
        esac
      fi
      fi
    done
  fi
elif [ "$CP_STATE" != "not-control-plane" ]; then
  echo "BLOCKING (§CP state '$CP_STATE' ⇒ not proven ordinary, held)"   # `unknown`, anything unenumerated, and the EMPTY STRING a failed invocation yields
fi
# The has-code/has-docs/has-skills probes are single-sourced as canonical HAS_*_RE= lines in
# gh-issue-intake-formats.md §CLASS and re-resolved from origin/main here (the #981 idiom, same as
# UI_RE below and as the §CP boundary cp-classify re-resolves internally) so this snapshot can't
# mis-classify — and so the reviewer (which consumes the SAME
# lines) fans across every present class in lockstep with what ship-it requires (#2383). The reviewer
# and this step both run `pipeline-cli class-probe classify` (which parses these SAME §CLASS lines —
# no third copy) as the deterministic class set, so `required == dispatched` can't diverge by an
# eyeball miss the way `.glossary/**` did on PR #2430 (#2434). FAIL CLOSED: an unreadable source ⇒
# dispatch/require the gate. The literals below are the fail-closed reference, NOT the live decision
# source — §CLASS is the source:
#   gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename' | pipeline-cli class-probe classify
HAS_CODE_RE='^(apps|packages|\.glossary|infra)/'
HAS_SKILLS_RE='^claude-plugins/[^/]+/(skills|agents)/|^\.claude-plugin/'
HAS_DOCS_EXCLUDE_RE='^(claude-plugins|apps|packages|\.glossary|infra)/'
HAS_DOCS_RE='^(\.decisions|\.patterns)/|\.md$'
CLASS_RAW="$(gh api "repos/$REPO/contents/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null || true)"
reresolve_re() { live="$(printf '%s\n' "$CLASS_RAW" | grep "^$1=" | head -n1 || true)"; if [ -z "$live" ]; then printf '%s' "$2"; else accept_re "$1" "$(printf '%s' "$live" | sed "s/^$1='//; s/'\$//")" "$2"; fi; }
HAS_CODE_RE="$(reresolve_re HAS_CODE_RE '.')"
HAS_SKILLS_RE="$(reresolve_re HAS_SKILLS_RE '.')"
HAS_DOCS_EXCLUDE_RE="$(reresolve_re HAS_DOCS_EXCLUDE_RE '\$^')"   # fail-closed: exclude NOTHING ⇒ every path reaches the doc test
HAS_DOCS_RE="$(reresolve_re HAS_DOCS_RE '.')"                     # fail-closed: every path is a doc
# `if … then … fi`, not `… && echo`: a class the diff does NOT carry is this probe's ORDINARY answer,
# and with `&& echo` the failing `grep` is the last command executed — so a docs-only PR would leave
# this script's exit status at 1 and §SHARED's "read the status first, non-zero is UNKNOWN" rule
# would make a perfectly good classification unreadable (rule 4). The predicates are byte-unchanged.
if echo "$FILES" | grep -Eq "$HAS_SKILLS_RE"; then echo "has-skills"; fi   # → review-skill (ADR 0073/0150); §CP-blocking for merge via the cp-classify derivation above
if echo "$FILES" | grep -Eq "$HAS_CODE_RE"; then echo "has-code"; fi       # → review-code; the has-code roots agree with the docs-exclusion below in lockstep (§CLASS/§DOC, #663/#919/#1987)
if echo "$FILES" | grep -Ev "$HAS_DOCS_EXCLUDE_RE" | grep -Eq "$HAS_DOCS_RE"; then echo "has-docs"; fi   # → review-doc; carve out code roots/skills/.glossary first, then test for a doc path (§DOC contract)
# No-class fail-closed (#2765): a NON-EMPTY diff whose files match NONE of the three classes above
# — root tooling outside the code roots (biome-plugins/**, biome.jsonc, turbo.json) — must NOT ship
# un-gated. `pipeline-cli class-probe classify` (the live decision source above) folds this in: any
# unclassified changed file rides has-code → review-code, so a non-empty diff never requires zero
# gates. This is the §CLASS "no-class fail-closed" rule, NOT a widened HAS_CODE_RE (that is #2761).
# UI probe → review-design (ADDITIVE, not a class): a changed path under apps/web/src — the
# rendered frontend surface (React components, styles, tokens, routes). `pipeline-cli class-probe
# classify` above ALSO emits `has-ui` (it parses this same UI_RE from its single source,
# ship-it/SKILL.md) — so the reviewer fan dispatches review-design off the SAME deterministic probe
# it fans the class gates from, rather than eyeballing the files and skipping it (the #2483 deadlock;
# #2485). Like the §CP boundary and GUARD_ADR_RE (both re-resolved inside their shared verbs above),
# the literal below is the fail-closed REFERENCE + the validate-gate-path-drift lockstep target, NOT
# the live decision source: it is re-resolved from
# origin/main right after, so an injected skill snapshot that predates the review-design gate can't
# silently DROP the UI probe and slip a UI PR past the gate (#2341 — the #981 idiom, previously only
# on §CP/GUARD, now extended to UI_RE). ship-it/SKILL.md@main's `UI_RE=` line is the ONE live source;
# reviewer.md, class-probe, AND review-design's Step 0 off-ramp all re-resolve the SAME line from the
# same ref, so required-gate == dispatched-gate == satisfiable-gate holds by construction — all sides
# read live main, not independently-aging snapshots. When a second app worker is added, generalize
# this one live UI_RE to apps/**/src and every side tracks it.
# SCOPE (#2470): UI_RE is `^apps/web/src/` ONLY — a `.tsx`/`.css` OUTSIDE apps/web/src (a Hono
# server-JSX file, a `.tsx` test fixture, a non-web `.css`) has no rendered surface, so it is NOT
# design-gate work and must NOT mint a required review-design. The earlier `|\.tsx$|\.css$` branches
# made the *require* predicate a superset of review-design's own dispatch/off-ramp predicate
# (`^apps/web/src/`): a non-web `.tsx` was required-but-unroutable — the dispatched review-design run
# off-ramped with no marker and ship-it deadlocked on a review-design PASS no run could produce.
# IN-SRC TEST CARVE-OUT (#3071): a change whose apps/web/src paths are ALL test/spec files renders no
# surface, so it must NOT mint a required review-design either — the src-colocated `*.test.tsx` next to
# a component (the established sibling-colocation convention) stalled #3046/#3047 at ship on a gate no
# run could satisfy. ERE (grep -E) has no negative lookahead, so a single UI_RE can't express "under
# src, but not a test" — mirror §CLASS's has-docs carve-then-test: strip test/spec files FIRST, THEN
# test for a UI path. A real component (apps/web/src/**/*.tsx non-test) or a mixed component+test diff
# survives the carve and STILL gates; only an all-test/spec src diff is exempted.
UI_RE='^apps/web/src/'
UI_EXCLUDE_RE='\.(test|spec)\.tsx?$'
UI_RAW="$(gh api "repos/$REPO/contents/claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null || true)"
UI_LIVE="$(printf '%s\n' "$UI_RAW" | grep '^UI_RE=' | head -n1 || true)"
UX_LIVE="$(printf '%s\n' "$UI_RAW" | grep '^UI_EXCLUDE_RE=' | head -n1 || true)"
if [ -n "$UI_LIVE" ]; then UI_RE="$(accept_re UI_RE "$(printf '%s' "$UI_LIVE" | sed "s/^UI_RE='//; s/'$//")" '.')"; else UI_RE='.'; fi   # FAIL CLOSED: can't read origin/main's UI_RE — or it resolves TRIVIAL — ⇒ '.' ⇒ every path UI-affecting ⇒ REQUIRE review-design, never silently skip (#2341/#4401)
if [ -n "$UX_LIVE" ]; then UI_EXCLUDE_RE="$(accept_re UI_EXCLUDE_RE "$(printf '%s' "$UX_LIVE" | sed "s/^UI_EXCLUDE_RE='//; s/'$//")" '$^')"; else UI_EXCLUDE_RE='$^'; fi   # FAIL CLOSED: unreadable or trivial ⇒ '$^' never-match ⇒ carve out NOTHING ⇒ every apps/web/src path (incl. tests) gates review-design
if echo "$FILES" | grep -Ev "$UI_EXCLUDE_RE" | grep -Eq "$UI_RE"; then echo "has-ui"; fi   # carve test/spec first, THEN require review-design ALONGSIDE the class gate(s)
