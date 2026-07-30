#!/usr/bin/env bash
# Sourced-only: the shared-contract shell functions review-design's extracted scripts call.
#
# THIS IS A RELOCATED RUNTIME COPY, NOT A SECOND SOURCE OF TRUTH. The single source is
# `../../gh-issue-intake-formats.md` — §CPREAD (`cp_changed_files`, `cp_head_sha`) and the
# verdict read-back guard (`verdict_readback_guard`). The SKILL.md blocks these scripts replace
# instructed the agent to copy those functions verbatim into its shell before calling them
# (§CPREAD: "copy it and `cp_head_sha` verbatim"), so a script boundary needs the same copy on
# disk. Nothing here may be edited independently: if the contract changes, this file follows it
# byte-for-byte.
#
# The copy is deliberately skill-local rather than in `../../shared/lib/common.sh`: several
# extraction children want these same functions, so whether they belong in the shared lib is a
# decision to take once, deliberately, rather than six times in parallel (#4453; epic #4435).
#
# Sourced, never executed: defines functions and sets no shell options, so the sourcing script
# keeps its own — the same contract `common.sh` holds.
#
# `verdict_readback_guard` reads the ambient `$REPO`; a caller sources this and sets
# `REPO="$(kp_repo)"` before calling it.

# §CPREAD — the ONE hardened read of a PR's changed-file list, the input to BOTH §CP clauses.
# Sets CP_FILES (the list) + CP_FILES_N (the scanned count); returns NON-ZERO on a read that could
# not execute. A non-zero return is UNKNOWN — hold as §CP — never "no control-plane path touched".
# --paginate + a STREAMING --jq (one line per file) is load-bearing: gh concatenates the per-page
# element streams, so a consumer's grep aggregates matches across ALL pages. The API caps per_page at
# 100 whatever you ask for, so a single non-paginated call truncates a >100-file PR — hiding a §CP
# file in the tail. Never pair --paginate with an AGGREGATE --jq (`[ … ]` / `length` / `add`): gh runs
# the filter PER PAGE and emits one result each (#725).
cp_changed_files() {   # $1 = REPO, $2 = PR
  CP_FILES="$(gh api --paginate "repos/$1/pulls/$2/files?per_page=100" \
    --jq 'if type=="array" then .[].filename else ("payload is not a file-list array"|halt_error(1)) end' 2>/dev/null)" || {
      CP_FILES=""; CP_FILES_N=0
      echo "§CP scope: PR #$2 changed-file list READ FAILED (gh exited non-zero; payload discarded) — 0 file(s) scanned" >&2
      return 1; }
  CP_FILES_N="$(printf '%s\n' "$CP_FILES" | grep -c . || true)"
  if [ "$CP_FILES_N" -eq 0 ]; then
    CP_FILES=""
    echo "§CP scope: PR #$2 changed-file list read returned ZERO files — a PR always changes >=1 file, so this is a FAILED READ, not a clean 'no §CP path'" >&2
    return 1
  fi
  echo "§CP scope: PR #$2 changed-file list read OK — $CP_FILES_N file(s) scanned"   # §ZS #1: state the scope the classification rests on
}

# The PR head SHA is the SECOND fallible read every §CP site makes — the ref the ADR-0164 content
# probe reads each ADR body at. It gets the same three properties, and for a reason worth stating
# once: `HEAD_SHA="$(gh api … --jq .head.sha || true)"` followed by `[ -n "$HEAD_SHA" ]` is a DEAD
# guard. On failure gh does not apply --jq at all — it writes its error document to STDOUT
# (property 2) — so the variable is NON-EMPTY and the emptiness test can never fire. Capture, check
# the exit status, DISCARD the payload, then shape-assert: a ref is 40 bare lowercase hex digits, so
# an error body (or any other unexpected 200) cannot pass for one.
cp_head_sha() {   # $1 = REPO, $2 = PR; sets CP_HEAD_SHA (EMPTY on failure), returns NON-ZERO ⇒ UNKNOWN
  CP_HEAD_SHA="$(gh api "repos/$1/pulls/$2" \
    --jq 'if type=="object" and (.head.sha|type)=="string" then .head.sha else ("payload is not a PR object"|halt_error(1)) end' 2>/dev/null)" || {
      CP_HEAD_SHA=""
      echo "§CP scope: PR #$2 head SHA READ FAILED (gh exited non-zero; payload discarded) — ADR content unprobeable" >&2
      return 1; }
  case "$CP_HEAD_SHA" in
    *[!0-9a-f]*|"") CP_HEAD_SHA=""; echo "§CP scope: PR #$2 head SHA is not bare hex — discarded" >&2; return 1 ;;
  esac
  [ "${#CP_HEAD_SHA}" -eq 40 ] || {
    CP_HEAD_SHA=""; echo "§CP scope: PR #$2 head SHA is not a 40-char ref — discarded" >&2; return 1; }
}

# verdict_readback_guard <comment-id> <gate> <head-sha>: re-read the just-posted verdict comment
# and PROVE it is a well-formed, leak-free, current-head-bound marker. FAIL LOUD (non-zero) on any
# miss — a broken marker reads to consumers as "no verdict", or worse a human skims it as posted.
# <gate> is one of: review-code | review-doc | review-skill | review-design — ALL FOUR PR gates, the
# same set the emit mandate below scopes and the same set the verdict lib enumerates (VerdictGate).
verdict_readback_guard() {
  local cid="$1" gate="$2" sha="$3"
  local got; got="$(gh api "repos/$REPO/issues/comments/$cid" --jq .body)" || {
    echo "verdict_readback_guard FAILED: cannot re-read comment $cid — treat the verdict as UNLANDED." >&2; return 1; }

  # (0) the body is non-empty. An empty/whitespace-only body carries no marker at all — the degenerate
  #     case of a garbled post (#2268); reject it up front so the failure names the real cause rather
  #     than falling through to (1)'s "no marker".
  if [ -z "$(printf '%s' "$got" | tr -d '[:space:]')" ]; then
    echo "verdict_readback_guard FAILED: comment $cid is empty/whitespace — no verdict landed; the PR is UNGATED." >&2; return 1
  fi

  # (1) the canonical gate marker token is present: either the bindable first-line
  #     `<gate>: PASS|FAIL @ <sha>` (SHA prefix-matched, ADR 0058), OR the SHA-less `<gate>: advisory`
  #     first line (blocking-set path — authorizes nothing but IS a posted verdict).
  printf '%s' "$got" | grep -Eiq "^[[:space:]]*\**[[:space:]]*${gate}:[[:space:]]*(PASS|FAIL)[[:space:]]*@[[:space:]]*${sha:0:7}" \
    || printf '%s' "$got" | grep -Eiq "^[[:space:]]*\**[[:space:]]*${gate}:[[:space:]]*advisory" \
    || { echo "verdict_readback_guard FAILED: no canonical '${gate}:' marker (PASS/FAIL @ ${sha:0:7} or advisory) in comment $cid — the body is malformed; the PR is UNGATED." >&2; return 1; }

  # (2) Head binding — SHA-SOURCE-AWARE (#2272), and every verdict body binds the reviewed head:
  #     - a bindable first line (`<gate>: PASS|FAIL @ <sha>`) carries the binding inline — (1) already
  #       validated it against ${sha:0:7}, so a non-blocking binding PASS/FAIL needs no separate line
  #       (this is the branch that keeps a legitimate non-blocking PASS from false-failing; #2272).
  #     - a SHA-less advisory first line (`<gate>: advisory`, ALL FOUR gates INCL review-code) MUST
  #       carry the canonical body `Reviewed-head: @ <sha>` line (§6.6 / ADR 0151) — absence is FATAL.
  #       (#2329: the prior "review-code's §CP advisory carries NONE by design → accept its absence"
  #       carve-out contradicted §6.6's own MUST and blinded the read-back to a drifted
  #       `**Reviewed head:**` variant — bold, space-not-hyphen, backticked SHA — that does NOT match
  #       `^Reviewed-head:` and that ship-it's §6.6 enqueue matcher then rejects, leaving a genuinely
  #       -approved §CP PASS silently unshippable until a human hand-re-posts. Requiring the canonical
  #       line on every advisory makes a drifted line read as absent → FATAL here → forces a canonical
  #       re-post at EMISSION time, never a ship-it refusal on an approved PR.)
  #     - ANY `Reviewed-head:` line present (advisory, or a belt-and-suspenders non-blocking PASS) must
  #       bind ${sha:0:7} — a mis-bound/stale one is ALWAYS fatal (a wrong head must never read verified).
  if printf '%s' "$got" | grep -Eiq "^[[:space:]]*\**[[:space:]]*${gate}:[[:space:]]*(PASS|FAIL)[[:space:]]*@[[:space:]]*${sha:0:7}"; then
    : # bindable first line: its `@ <sha>` IS the head binding (validated by (1))
  elif ! printf '%s' "$got" | grep -Eiq "^[[:space:]]*Reviewed-head:"; then
    echo "verdict_readback_guard FAILED: SHA-less advisory in comment $cid carries no canonical 'Reviewed-head: @ ${sha:0:7}' line — §6.6/ADR 0151 requires it on ALL four gates' advisories (incl review-code); a drifted '**Reviewed head:**' variant reads as absent. Re-post the canonical 'Reviewed-head: @ <sha>' line (hyphen, no bold, no backticks around the SHA)." >&2; return 1
  fi
  # a present `Reviewed-head:` line (advisory OR a non-blocking PASS that also carries it) must bind head:
  if printf '%s' "$got" | grep -Eiq "^[[:space:]]*Reviewed-head:"; then
    printf '%s' "$got" | grep -Eiq "^[[:space:]]*Reviewed-head:[[:space:]]*@?[[:space:]]*${sha:0:7}" \
      || { echo "verdict_readback_guard FAILED: 'Reviewed-head:' line in comment $cid is bound to the wrong head (not @ ${sha:0:7}) — a stale/mis-bound head binding." >&2; return 1; }
  fi

  # (3) NO local filesystem path leaked into the public body (the #2148/#2268 leak). Reject a
  #     machine-local scratch/home path or a leading `@<path>` marker-as-path. Match by absolute ROOT
  #     (`/Users`, `/var`, `/tmp`, `/private`) — the roots a `mktemp`/scratchpad path lands under —
  #     not just `/var/folders/`, so a leaked path under any of them cannot read green (#2268). Patterns
  #     are placeholders, not real paths — this file stays leak-clean.
  if printf '%s' "$got" | grep -Eq '(/var/|/Users/|/tmp[/.]|/private/|(^|[[:space:]])~/|(^|[[:space:]])@/)'; then
    echo "verdict_readback_guard FAILED: comment $cid leaks a local filesystem path in its body — a #2148/#2268 marker-as-path leak; refuse and re-post the real verdict." >&2
    return 1
  fi

  echo "verdict_readback_guard OK: ${gate} verdict @ ${sha:0:7} landed on comment $cid — marker + head binding valid, no local-path leak."
}
