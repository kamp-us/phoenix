#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091
# Classify the diff: the §CP derivation, then the artifact-class + UI answer, both from shared verbs.
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 0 fenced block (epic #4435 phase 1, #4448).
# The class/UI half is no longer that byte-move: it delegates to `pipeline-cli class-probe classify`
# rather than re-deriving a second, smaller answer beside it (#4730 — see the block below).
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
# §CLASS's NON-TRIVIALITY ASSERT used to live here, guarding the gate boundaries this step stripped
# out of a network read itself. It went with them: this step no longer resolves a boundary regex —
# the shared verbs below do, each behind its own copy of that assert.
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
# THE CLASS SET IS `class-probe`'s ANSWER, PRINTED — one derivation, not two (#4730, finishing #2765).
#
# This step used to re-implement the §CLASS probes here: four re-resolved HAS_*_RE literals plus a
# re-resolved UI_RE, three `grep -Eq` class tests and one UI test. That copy answered a STRICT SUBSET
# of `class-probe`'s, in one direction only — its failure mode on a file matching none of the three
# predicates was SILENCE, and silence subtracts a class. `class-probe` does the opposite in code
# (`files.some(isCode) || files.some((f) => !isClassified(f))`), so an unclassified file rides
# has-code there and vanished here. On PR #4724 the copy printed `has-skills` alone where the probe
# printed `has-code, has-skills` — the three `claude-plugins/fabrika/{README.md,docs/**}` files are
# under no code root, under no `skills/`|`agents/` segment, and carved out of the doc test, so they
# classified nowhere. Any plugin home carrying docs beside its skills reproduces it.
#
# The rule was never dropped here — it was never written here. The commit closing #2765 added it to
# this step as five comment lines and zero executable lines, i.e. BORN DEAD, and stated the design
# intent in the same breath: the rule "lives once in the shared class-probe core that ship-it Step 0
# and the reviewer fan both run". Printing the probe's output is therefore #2765 finished, not a
# redesign — and it is the same verb Step 2 re-derives the required set from, so Step 0's printed set
# and Step 2's enforced set are now identical BY CONSTRUCTION rather than by matched maintenance.
#
# The HAS_*_RE / UI_RE literals are gone from this file along with the derivation they served. That
# does NOT remove drift detection: `validate-gate-path-drift.sh` locks each boundary's CANONICAL
# (invariants 1b/1d, in gh-issue-intake-formats.md §CLASS and ship-it/SKILL.md) against the typed
# const in packages/pipeline-cli/src/gate-boundaries.ts, and 1c value-locks whatever copies exist.
# A copy that no longer exists cannot drift; the anchor it was checked against is untouched.
CLASS_OUT="$(printf '%s\n' "$FILES" | "$PCLI" class-probe classify)" || {
  echo "BLOCKING (class-probe could not classify ⇒ required-gate set UNKNOWN, held — ADR 0092 §ZS)"
  echo "STOP: classification unresolved — refuse to enqueue and report the failed probe; do NOT read this as 'no gates required'."
  exit 1
}
# NO-CLASS FAIL-CLOSED (#2765) — as EXECUTABLE CODE, which is the whole point. Its operands come from
# two different origins, which is what makes it able to fire: the file COUNT is §CPREAD's ($CP_FILES_N,
# already proven ≥ 1 — `cp_changed_files` fails closed on a zero-length list), the class SET is
# class-probe's stdout. A non-empty diff that spans zero classes would require zero gates, i.e. a
# vacuous conjunction — an un-gated merge reported as a clean one. `class-probe` folds the rule in
# (an unclassified file rides has-code), so reaching this branch means the probe itself answered
# emptily; that is UNKNOWN, and UNKNOWN is never "no gates required".
if [ -z "$CLASS_OUT" ]; then
  echo "BLOCKING ($CP_FILES_N changed file(s) but the class set came back EMPTY ⇒ zero required gates would be a vacuous conjunction, held — §CLASS no-class fail-closed, #2765/#4730)"
  echo "STOP: classification unresolved — refuse to enqueue; do NOT read this as 'no gates required'."
  exit 1
fi
# One class word per line, `has-ui` last when the diff renders a surface — the probe's own emission
# order, passed through unaltered. Carry THIS set into Step 2 (which re-derives it from the same verb).
printf '%s\n' "$CLASS_OUT" | grep -v '^has-code$'
