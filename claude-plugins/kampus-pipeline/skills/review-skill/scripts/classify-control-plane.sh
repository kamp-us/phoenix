# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
PR=<pr number>
# The shared §CP classification entry point — one verb all the gates cite (#4161, formats §CP). It
# re-resolves CONTROL_PLANE_RE from origin/main itself (§CP travels in the INJECTED skill snapshot,
# which can lag origin/main even when the on-disk file is current — a pre-amendment snapshot once
# mis-flagged a now-control-plane PR as auto-mergeable, #981) AND covers the second §CP source: a
# guard-touching `.decisions/**` ADR is §CP BY CONTENT (ADR 0164) with zero path matches, so the old
# path-only grep here flagged it non-blocking — the fail-open this verb removes.
# Four states on stdout: control-plane / content-undetermined / not-control-plane / unknown.
# Assert on the STATE WORD, never on the exit status — the exit code discriminates the four states
# only once the verb has RUN, so `… || ordinary` fail-opens on a usage error (1) or a missing
# binary (127). The `else` below is the catch-all that makes that safe (formats §CP; #4161).
# The verb's INPUT is a fallible read, so it comes from §CPREAD's `cp_changed_files` (copy it and
# `cp_head_sha` verbatim from ../gh-issue-intake-formats.md) — never a bare `gh api … |` pipe: with
# pipefail off, a failed read pipes gh's stdout ERROR BODY into the verb, which matches no §CP clause
# and answers `not-control-plane` (#4216).
if ! cp_changed_files "$REPO" "$PR"; then
  CP_STATE=unknown   # the input never arrived ⇒ UNKNOWN ⇒ held as §CP by the catch-all below
else
  CP_STATE="$(printf '%s\n' "$CP_FILES" | "$PCLI" cp-classify classify --repo "$REPO")"
fi
# `content-undetermined` is an OBLIGATION, not an answer: probe each touched ADR at head with the
# SAME ADR-0164 verb ship-it Step 0 and review-code/review-doc run. Any BLOCKING line ⇒ §CP.
if [ "$CP_STATE" = "content-undetermined" ]; then
  cp_head_sha "$REPO" "$PR"; HEAD_SHA="$CP_HEAD_SHA"   # EMPTY on failure (payload discarded) — §CPREAD
  [ -n "$HEAD_SHA" ] || echo "BLOCKING (head SHA unreadable — ADR content unprobeable ⇒ §CP, fail-closed)"
  [ -z "$HEAD_SHA" ] || printf '%s\n' "$CP_FILES" \
    | grep -E '^\.decisions/.*\.md$' | while IFS= read -r adr; do
        # Capture and CHECK, never a straight pipe — gh writes its error document to STDOUT, so a
        # pipe hands the probe an ERROR BODY as the ADR body (§CPREAD #2).
        adr_body="$(gh api "repos/$REPO/contents/$adr?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' 2>/dev/null)" || adr_body=""
        if [ -z "$adr_body" ]; then echo "BLOCKING ($adr — body unreadable at head ⇒ §CP, fail-closed)"
        else
          # Same rule as the cp-classify call above: assert on the probe's STATE WORD, never on its
          # exit status — an invocation that never ran would otherwise read as proven ordinary (#4219).
          GC_STATE="$(printf '%s' "$adr_body" | "$PCLI" guard-content-probe classify --path "$adr" 2>/dev/null)"
          case "$GC_STATE" in
            not-guard-touching) : ;;   # proven ordinary — the ONLY value that may skip the §CP hold
            guard-touching) echo "BLOCKING ($adr — guard-touching ADR ⇒ §CP, ADR 0164)" ;;
            *) echo "BLOCKING ($adr — probe UNDETERMINED (state '$GC_STATE') ⇒ §CP, fail-closed)" ;;
          esac
        fi
      done
elif [ "$CP_STATE" != "not-control-plane" ]; then
  # The catch-all: control-plane, unknown, AND anything unenumerated — the empty string a failed
  # invocation yields included. Only a positive `not-control-plane` may skip the hold.
  echo "BLOCKING (§CP state '$CP_STATE')"
fi
# blocking → advisory only; a control-plane approval @head → ship-it enqueues (ADR 0135; §CP set 0053/0065/0073)
