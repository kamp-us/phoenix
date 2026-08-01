#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034,SC2086,SC2181
# Locate the run-evidence run for the exact head SHA and fetch its artifact zip.
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3.5 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step3_5-fetch-artifact.sh <REPO> <PR>
#              stdout ⇒ six lines — `HEAD_SHA=`, `RUN_ID=`, `ART_ID=`, `MANIFEST=`,
#              `ART_FETCH_STATUS=`, `ART_FETCH_ERR=` — the values the sourced form left in the
#              caller's shell, and exactly the inputs `step3_5-assert-bundle.sh` now takes as
#              arguments. `RUN_ID` / `ART_ID` are legitimately EMPTY on a genuinely absent bundle,
#              which is assertion 1b's input, so each line is printed unconditionally: an absent line
#              would be indistinguishable from a fetch that never ran (rule 4 / §ZS). The BUNDLE
#              itself stays on disk under the per-run `mktemp -d` that `MANIFEST=` points into — the
#              one piece of cross-step state that is a FILE, so a process boundary does not lose it.
#   SOURCED:   no in-script consumer today; the edge stays open for one.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479). It also must not delete $BUNDLE_DIR:
# the next step reads the manifest out of it.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

REPO="${REPO:-${1:?step3_5-fetch-artifact.sh: REPO unset and no \$1 — refusing to fetch evidence from an unnamed repo}}"
PR="${PR:-${2:?step3_5-fetch-artifact.sh: PR unset and no \$2 — refusing to fetch evidence for an unnamed PR}}"

HEAD_SHA=$(gh api repos/$REPO/pulls/$PR --jq '.head.sha')

# --- transient-aware bundle fetch (the #3716 fix) -----------------------------------------------
# A GitHub 5xx during the bundle fetch is UPSTREAM-UNAVAILABLE (a transport failure) — NOT a
# producer that yielded nothing. Collapsing the two is the exact defect this guard's own note calls
# out as load-bearing: on PR #3693 an outage wrote a 169-byte JSON 503 body into run-evidence.zip,
# `unzip` failed, no manifest landed, and the gate reported "no run-evidence bundle" for a bundle
# that was present the whole time. So every read below RETRIES a transient failure with backoff,
# CAPTURES its stderr cause (never `2>/dev/null` — that swallowed the 503 that would have named the
# outage), and — for the zip — verifies the bytes are a real archive by magic number before trusting
# them. A failure that survives the retries is classified UNKNOWN (unverified-transient), never read
# as an absent bundle (probe convention: an unrunnable probe is "unknown", never "down").
ART_FETCH_ERR=""   # last captured transient cause, surfaced verbatim in the transient refusal reason

gh_read_retry() {   # $1=api-path $2=jq-filter → echoes the jq result; exit 0 = read ok (INCLUDING a
                    # valid response with no match — legit-empty, NOT transient), 1 = transient after retries.
  local path="$1" jqf="$2" attempt=0 rc out errfile
  errfile=$(mktemp "${TMPDIR:-/tmp}/ship-it-ghread.XXXXXX")
  while [ "$attempt" -lt 4 ]; do
    [ "$attempt" -gt 0 ] && sleep $(( 1 << (attempt - 1) ))   # 1s, 2s, 4s backoff before retries 2–4
    attempt=$((attempt + 1))
    out=$(gh api "$path" --jq "$jqf" 2>"$errfile"); rc=$?
    if [ "$rc" -eq 0 ]; then rm -f "$errfile"; printf '%s' "$out"; return 0; fi
    ART_FETCH_ERR="attempt $attempt reading ${path##*/}: gh exited $rc — $(tr -d '\n' <"$errfile" | head -c 160)"
  done
  rm -f "$errfile"; return 1
}

is_zip() {   # 0 iff $1 opens with the ZIP local-file-header magic PK\x03\x04 — a real archive, not a
             # JSON error body (the incident: a 169-byte 503 payload written where a zip was expected).
  [ -s "$1" ] || return 1
  [ "$(dd if="$1" bs=4 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "504b0304" ]
}

fetch_artifact_zip() {   # $1=ART_ID $2=dest ; 0 = a VALID zip landed, 1 = transient failure after retries
  local art_id="$1" dest="$2" attempt=0 rc errfile
  errfile=$(mktemp "${TMPDIR:-/tmp}/ship-it-artfetch.XXXXXX")
  while [ "$attempt" -lt 4 ]; do
    [ "$attempt" -gt 0 ] && sleep $(( 1 << (attempt - 1) ))
    attempt=$((attempt + 1))
    gh api "repos/$REPO/actions/artifacts/$art_id/zip" > "$dest" 2>"$errfile"; rc=$?
    if [ "$rc" -eq 0 ] && is_zip "$dest"; then rm -f "$errfile"; return 0; fi
    if [ "$rc" -ne 0 ]; then
      ART_FETCH_ERR="attempt $attempt downloading artifact $art_id: gh exited $rc — $(tr -d '\n' <"$errfile" | head -c 160)"
    else
      ART_FETCH_ERR="attempt $attempt downloading artifact $art_id: $(wc -c <"$dest" | tr -d ' ')-byte non-zip payload (magic mismatch — an error body, not an archive)"
    fi
  done
  rm -f "$errfile"; return 1
}
# ------------------------------------------------------------------------------------------------

# ART_FETCH_STATUS ∈ {absent, ok, transient} — the #3716 distinction, decided HERE during the fetch,
# NOT inferred from an empty manifest downstream. `absent` = a read succeeded but the producer yielded
# nothing; `transient` = a read/download 5xx'd or returned a non-zip body after retries (UNKNOWN).
ART_FETCH_STATUS=absent

# the run-evidence workflow run for THIS exact head SHA (not a stale earlier push)
RUN_ID=$(gh_read_retry "repos/$REPO/actions/runs?head_sha=$HEAD_SHA&per_page=100" \
  '[.workflow_runs[] | select(.name=="run-evidence")] | sort_by(.created_at) | last | .id // empty')
# `if … fi` bodies below (rule 4): the ORDINARY case is a read that SUCCEEDED, which makes
# `[ $? -ne 0 ]` false — as an `&&` body that failing test would be the last command executed on the
# clean path and would leak a 1 into this script's status. `$?` is still read first, unchanged.
if [ $? -ne 0 ]; then ART_FETCH_STATUS=transient; fi

# the run-evidence artifact id (retry-aware — a 5xx here is UNKNOWN, not an absent artifact)
ART_ID=""
if [ "$ART_FETCH_STATUS" != transient ] && [ -n "$RUN_ID" ]; then
  ART_ID=$(gh_read_retry "repos/$REPO/actions/runs/$RUN_ID/artifacts" \
    '.artifacts[] | select(.name=="run-evidence") | .id')
  if [ $? -ne 0 ]; then ART_FETCH_STATUS=transient; fi   # `if … fi`, same rule-4 reason as above
fi

# per-run bundle dir (mktemp -d), NOT a fixed /tmp/ship-it-bundle — the §SP per-run scratchpad
# namespace (gh-issue-intake-formats.md): concurrent §CP shippers fan out, and a shared path lets
# two racing runs read each other's bundle — merge-safety must not rest on Step 3.5's
# commit==head assertion catching the swap after the fact (#2281; the #3718 silent-clobber class).
BUNDLE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ship-it-bundle.XXXXXX")
MANIFEST="$BUNDLE_DIR/manifest.json"

# Download + unzip ONLY when a producer run + artifact both resolved. An empty RUN_ID/ART_ID is
# genuine absence (assertion 1b); a LISTED artifact we cannot fetch as a valid zip is TRANSIENT.
if [ "$ART_FETCH_STATUS" != transient ] && [ -n "$RUN_ID" ] && [ -n "$ART_ID" ]; then
  if fetch_artifact_zip "$ART_ID" "$BUNDLE_DIR/run-evidence.zip"; then
    unzip -oq "$BUNDLE_DIR/run-evidence.zip" -d "$BUNDLE_DIR" \
      && ART_FETCH_STATUS=ok \
      || ART_FETCH_STATUS=transient   # valid magic but unreadable ⇒ a corrupt/truncated transfer, still transient
  else
    ART_FETCH_STATUS=transient        # a listed artifact that will not download as a valid zip = UNKNOWN
  fi
fi

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  printf 'HEAD_SHA=%s\n' "$HEAD_SHA"
  printf 'RUN_ID=%s\n' "$RUN_ID"
  printf 'ART_ID=%s\n' "$ART_ID"
  printf 'MANIFEST=%s\n' "$MANIFEST"
  printf 'ART_FETCH_STATUS=%s\n' "$ART_FETCH_STATUS"
  printf 'ART_FETCH_ERR=%s\n' "$ART_FETCH_ERR"
fi
