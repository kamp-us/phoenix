#!/usr/bin/env bash
# The verdict read-back guard + its unconditional wrapper, extracted from
# `gh-issue-intake-formats.md` (epic #4435 phase 1, #4450). The *why* — why the read-back must be
# unconditional and resolve the landed verdict from PR state rather than a carried id — stays in that
# contract's "verdict read-back guard" / "Make the read-back UNCONDITIONAL" prose; the per-check
# comments travelled with the shell.
#
# MECHANICAL MOVE. Every moved line is byte-identical to the fence it came from and sits at column 0,
# so a reviewer can diff it against the deleted blocks directly. Verbification is phase 2 (#1929,
# ADR 0228: a script may RELAY a verb's answer, never DERIVE the decision). Do not "improve" it here.
#
# Sourced, never executed: it defines two functions and sets no shell options, so the caller keeps its
# own `set -euo pipefail`. No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the
# script's status, which launders a `set -u` abort into exit 0 (#4476, class #4479).
#
# Reads $REPO from the caller, exactly as the fences did. The local-path patterns in checks (3)/(E)
# are PLACEHOLDERS the guard matches against a comment body — never real paths, so this file, like the
# contract it came from, stays leak-clean.

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
  #     are placeholders, not real paths — this doc stays leak-clean.
  if printf '%s' "$got" | grep -Eq '(/var/|/Users/|/tmp[/.]|/private/|(^|[[:space:]])~/|(^|[[:space:]])@/)'; then
    echo "verdict_readback_guard FAILED: comment $cid leaks a local filesystem path in its body — a #2148/#2268 marker-as-path leak; refuse and re-post the real verdict." >&2; return 1
  fi

  echo "verdict_readback_guard OK: ${gate} verdict @ ${sha:0:7} landed on comment $cid — marker + head binding valid, no local-path leak."
}

# verdict_post_verify <PR> <gate> <head-sha>: the UNCONDITIONAL post-verification, run after ANY
# verdict post/upsert (native APPROVE, comment PATCH-upsert, comment POST, advisory). It does NOT
# rely on a $MINE/$CID captured on one posting branch — it RE-SCANS the PR's live state to resolve
# whatever landed, then proves it well-formed + leak-free. Returns 0 ONLY on a proven-clean landed
# verdict; non-zero (FATAL) on absent / malformed / leaking.
# <gate> ∈ review-code|review-doc|review-skill|review-design — all four PR gates, same set as above.
verdict_post_verify() {
  local PR="$1" gate="$2" sha="$3" me cid approved rbody
  me="$(gh api user --jq .login)"
  # (A) resolve MY landed marker COMMENT id for this gate — the SHA-bound `<gate>: PASS|FAIL @ <sha>`
  #     first line OR the SHA-less `<gate>: advisory` line — re-scanned from PR state, NOT a carried id.
  #     A whole-body-path leak (#2264) has NO `<gate>:` first line, so it resolves empty here → caught in (C).
  cid=$(gh api "repos/$REPO/issues/$PR/comments?per_page=100" \
    | jq -r --arg me "$me" --arg g "$gate" --arg sha "${sha:0:7}" '
        [ .[] | select(.user.login==$me)
              | select((.body | test("^\\s*\\**\\s*" + $g + ":\\s*(PASS|FAIL)\\s*@\\s*" + $sha; "i"))
                        or (.body | test("^\\s*\\**\\s*" + $g + ":\\s*advisory"; "i"))) ]
        | sort_by(.created_at) | last | .id // empty')
  # (B) or a native approving REVIEW GitHub bound to this exact head (commit_id == head; its own SHA anchor):
  approved=$(gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
    --jq "[.[] | select(.user.login==\"$me\" and .commit_id==\"$sha\" and .state==\"APPROVED\")] | length")
  rbody=$(gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
    --jq "[.[] | select(.user.login==\"$me\" and .commit_id==\"$sha\" and .state==\"APPROVED\")] | last | .body // empty")
  echo "verdict_post_verify: PR #$PR ${gate} @ ${sha:0:7} -> comment=${cid:-none} native-approve=${approved:-0}"

  # (C) FATAL: nothing bound to this head landed — the post no-opped, OR the body carries no marker
  #     line at all (the #2264 whole-body-path leak leaves no `<gate>:` first line). The PR is UNGATED.
  if [ -z "$cid" ] && [ "${approved:-0}" -eq 0 ]; then
    echo "verdict_post_verify FAILED (fatal): no ${gate} verdict bound to head ${sha:0:7} landed on PR #$PR — the post no-opped or the marker's first line is absent (a whole-body local-path leak leaves no marker). Re-post the real by-value verdict; if it still cannot land, report a POSTING FAILURE — the PR is ungated." >&2
    return 1
  fi

  # (D) UNCONDITIONAL shape + leak read-back on the landed COMMENT — covers PATCH-upsert, POST, and
  #     advisory (every comment post path). $cid came from a re-scan, so this runs no matter which
  #     branch posted; the guard asserts marker shape + `Reviewed-head:` + NO local-path leak.
  if [ -n "$cid" ]; then
    verdict_readback_guard "$cid" "$gate" "$sha" || {
      echo "verdict_post_verify FAILED (fatal): landed ${gate} comment $cid on PR #$PR is malformed or leaks a local filesystem path — delete/re-post the real by-value verdict and re-verify; never leave a broken/leaking marker." >&2
      return 1
    }
  fi

  # (E) UNCONDITIONAL leak check on the native-APPROVE body too. The APPROVE body is by-value, but a
  #     hand-assembled body could still carry a local path; its SHA binding is the commit_id, so ONLY
  #     the leak check applies (no `Reviewed-head:` line is required of a native approve). LINEAR regex
  #     (literal alternation + anchored `(^|[[:space:]])` — no nested quantifier, no ReDoS), the same
  #     pattern verdict_readback_guard uses; paths are placeholders, keeping this doc leak-clean.
  if [ "${approved:-0}" -gt 0 ] && [ -n "$rbody" ]; then
    if printf '%s' "$rbody" | grep -Eq '(/var/|/Users/|/tmp[/.]|/private/|(^|[[:space:]])~/|(^|[[:space:]])@/)'; then
      echo "verdict_post_verify FAILED (fatal): native APPROVE review body on PR #$PR leaks a local filesystem path — dismiss/re-post a clean by-value verdict." >&2
      return 1
    fi
  fi

  echo "verdict_post_verify OK: ${gate} verdict @ ${sha:0:7} landed clean on PR #$PR (comment=${cid:-none} native-approve=${approved:-0}) — present, well-formed, leak-free."
}
