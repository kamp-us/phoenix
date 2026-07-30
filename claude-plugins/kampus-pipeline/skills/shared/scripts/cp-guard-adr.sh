#!/usr/bin/env bash
# §CP content clause (ADR 0164) — the guard-touching-ADR probe, extracted from
# `gh-issue-intake-formats.md` (epic #4435 phase 1, #4450). The *why* stays in that contract's
# "§CP … guard-touching ADR predicate" prose; the comments below travelled with the shell.
#
# MECHANICAL MOVE. Every moved line below is byte-identical to the fence it came from and sits at
# column 0, so a reviewer can diff it against the deleted block directly. The only additions are the
# argument + sourcing seam in this header block. Replacing the glue with `pipeline-cli` verbs is
# phase 2 (#1929, ADR 0228). Do not "improve" it here.
#
# Prints one `BLOCKING (…)` line per §CP finding on stdout, exactly as the fence did; a caller that
# needs no variables back may run it (`bash cp-guard-adr.sh "$REPO" "$PR"`), and a caller that wants
# $GUARD_ADR_RE / $HEAD_SHA in its own shell sources it after exporting REPO and PR.
#
# NO shell options and NO EXIT trap on purpose: `set -u` plus a cleanup EXIT trap makes the trap's
# last command the script's status under bash 3.2, converting an unbound-variable abort into exit 0
# (#4476, class #4479). Failure here is signalled the way the fence signalled it — on stdout.

REPO="${REPO:-${1:?cp-guard-adr.sh: REPO unset and no \$1 — refusing to probe an unnamed repo}}"
PR="${PR:-${2:?cp-guard-adr.sh: PR unset and no \$2 — refusing to probe an unnamed PR}}"
# §CPREAD owns cp_head_sha. The fence relied on the reader having pasted §CPREAD into the same shell
# first; sourcing makes that dependency explicit instead of latent — the cross-block defect the
# extraction exists to fix. $CP_FILES is likewise the caller's, from cp_changed_files: an unset one is
# an unread list, which is UNKNOWN and must never read as "no §CP path touched" (#4216).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/cp-read.sh"
: "${CP_FILES?cp-guard-adr.sh: CP_FILES unset — run cp_changed_files (§CPREAD) first; an unread list is UNKNOWN, never 'no §CP path touched'}"

# §CP content clause (ADR 0164): a touched .decisions/** ADR whose CONTENT matches GUARD_ADR_RE is
# §CP. Resolve GUARD_ADR_RE from origin/main at run time (like CONTROL_PLANE_RE, #981); read each
# ADR's body at the PR head. FAIL CLOSED: an unreadable boundary ⇒ match-everything; an unreadable
# ADR (delete/404) ⇒ §CP — never auto-ship an ADR that could not be read and proven guard-free.
# This recipe carries NO seed copy of GUARD_ADR_RE: it used to, byte-identical to the canonical
# above, and since every consumer resolves first-occurrence-wins that second line was an unguarded
# shadow a corrective edit could land on and appear to work (#4401). The live read below is the
# only resolution, and it already fails closed when it can't be made.
GA_LIVE="$(gh api "repos/$REPO/contents/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null | grep '^GUARD_ADR_RE=' | head -n1 || true)"
# accept_re (§CLASS) is the NON-TRIVIALITY ASSERT: a stripped value that is empty, or that still
# carries the assignment prefix, is refused here rather than gated on (#4401). Single-sourced in
# §CLASS and copied down here — as ship-it's Step 0 copies it — because a fenced recipe must run
# standalone when pasted; a cross-block call resolves to `command not found`, an empty pattern,
# and every touched ADR classified §CP (#4413).
accept_re() {   # $1=name, $2=resolved value, $3=fail-closed default
  case "$2" in
    *"$1='"*) : ;;
    *) if [ "${#2}" -ge 4 ]; then printf '%s' "$2"; return 0; fi ;;
  esac
  printf 'TRIVIAL-GATE-BOUNDARY: %s did not resolve to a usable pattern — failing closed.\n' "$1" >&2
  printf '%s' "$3"
}
if [ -n "$GA_LIVE" ]; then GUARD_ADR_RE="$(accept_re GUARD_ADR_RE "$(printf '%s' "$GA_LIVE" | sed "s/^GUARD_ADR_RE='//; s/'$//")" '.')"; else GUARD_ADR_RE='.'; fi   # FAIL CLOSED: '.' ⇒ every ADR word matches ⇒ every touched ADR is §CP
# The ref and the file list are fallible reads too — both come from §CPREAD (below), so an
# unreadable head SHA leaves HEAD_SHA EMPTY (payload discarded) rather than holding gh's error body.
cp_head_sha "$REPO" "$PR"; HEAD_SHA="$CP_HEAD_SHA"
[ -n "$HEAD_SHA" ] || echo "BLOCKING (head SHA unreadable — ADR content unprobeable ⇒ §CP, fail-closed)"
printf '%s\n' "$CP_FILES" | grep -E '^\.decisions/.*\.md$' | while IFS= read -r adr; do
  [ -z "$adr" ] && continue
  [ -n "$HEAD_SHA" ] || break
  # Capture and CHECK, never `|| true`: gh writes its error document to STDOUT, so `|| true` would
  # leave that JSON in $body, skip the fail-closed branch below, and grep an ERROR DOC for guard
  # vocabulary (§CPREAD property 2).
  body="$(gh api "repos/$REPO/contents/$adr?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' 2>/dev/null)" || body=""
  if [ -z "$body" ]; then echo "BLOCKING ($adr — unreadable at head ⇒ §CP, fail-closed)"
  elif printf '%s' "$body" | grep -Eiq "$GUARD_ADR_RE"; then echo "BLOCKING ($adr — guard-touching ADR ⇒ §CP, ADR 0164)"; fi
done
