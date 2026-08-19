# guard-content-probe

`pipeline-cli guard-content-probe classify` — the **shared ADR-0164 guard-touching-ADR
content probe**. Classifies one `.decisions/**` ADR body as `guard-touching` (§CP by
content) or `not-guard-touching`, so the **review gate**, the **driver**, and **ship-it
Step 0** all reach the same §CP verdict for the same diff through one verb (issue
[#3645](https://github.com/kamp-us/phoenix/issues/3645), founder ruling
[#3416](https://github.com/kamp-us/phoenix/issues/3416)).

## Why it exists

`.decisions/**` is otherwise non-blocking — it auto-merges on a `review-doc` PASS. But an
ADR that **relaxes, amends, or widens an exemption on a documented guard** is control-plane
by *nature* (it weakens the pipeline's own guardrails), and its **path** is
indistinguishable from an ordinary ADR's (ADR
[0164](https://github.com/kamp-us/phoenix/blob/main/.decisions/0164-guard-relaxing-adr-cp-gate.md),
[#2191](https://github.com/kamp-us/phoenix/issues/2191)).

Before #3645, only **ship-it Step 0** re-classified such an ADR by content — the review gate
and the driver classified §CP by **path regex alone**. A guard-relaxing ADR (live: PR
[#3415](https://github.com/kamp-us/phoenix/pull/3415) / ADR 0194) therefore read NON-§CP at
review and driver and was caught only at ship-it: a latent §CP-routing hole if ship-it is
ever bypassed. This verb is the single content probe every stage now calls, so the
classification is consistent.

## Generic content-shape, never a named list

The probe matches over **guard/fail-closed/enforcement vocabulary**, never a hardcoded
ADR/name list — an author-declared tag is self-defeating (the agent that lacks the
discipline to hold the guard also won't tag it; ADR 0164 MECHANISM), and a named deny-list
is the [#2393](https://github.com/kamp-us/phoenix/issues/2393) prohibition. "You cannot
relax a guard without naming it," so a probe over the guard vocabulary catches the class an
author tag would let slip.

## Single source

The canonical `GUARD_ADR_RE` vocabulary is **not** re-declared here — it is parsed from
`gh-issue-intake-formats.md` §CP, the one definition ship-it Step 0 and the reviewer fan
re-resolve (exactly as `class-probe` parses `HAS_*_RE`). There is no second copy to drift.

## Split of concerns

IO in the thin bin (`command.ts`) — reading the ADR body from stdin and `GUARD_ADR_RE` from
the local §CP; the whole predicate in the pure core (`guard-content-probe.ts`). The **caller**
owns the `gh api` REST resolution of each `.decisions/**` file's body at the PR head.

## Fail-closed (ADR 0164 / ADR 0092)

Every ambiguity resolves to `guard-touching` (§CP): an unreadable §CP boundary defaults to
`.` (match-everything), an uncompilable regex matches everything, and a null/empty ADR body
(a delete/404/unreadable head) classifies guard-touching. The probe over-routes a
merely-guard-*citing* ADR to a cheap human approval rather than risk missing a
guard-*relaxer* that would auto-ship a weakened gate.

## How to call this safely

The decision word (`guard-touching` | `not-guard-touching`) goes to **stdout**; a human
reason goes to **stderr**. Exit is **0 on `guard-touching`** and
**3 on `not-guard-touching`** (`PROVEN_ORDINARY_EXIT_CODE`, the shared rule in
[`../../exit-codes.ts`](../../exit-codes.ts) — the same code `cp-classify` seats its
proven-ordinary verdict on).

**Assert on the stdout state word, never on the exit status.** The exit code discriminates
the two verdicts only *once the verb has run*; it says nothing about whether it ran. Three
outcomes must stay distinguishable — proven-ordinary, proven-guard, and could-not-determine —
and only the first may skip the §CP hold:

```bash
# (v1 caller idiom, retired with the kampus-pipeline plugin — #5937; kept as the worked example
# of the state-word contract.) Read each touched .decisions/** ADR's body at head, probe it.
PCLI="node packages/pipeline-cli/src/bin.ts"
# `cp_head_sha` was §CPREAD of the v1 formats doc: it DISCARDS gh's payload on a
# failed read, so an empty HEAD_SHA is a live guard rather than 120 chars of error JSON (#4216).
cp_head_sha "$REPO" "$PR"; HEAD_SHA="$CP_HEAD_SHA"
[ -n "$HEAD_SHA" ] || echo "BLOCKING (head SHA unreadable ⇒ no ref to probe at ⇒ §CP, fail-closed)"
[ -z "$HEAD_SHA" ] || echo "$FILES" | grep -E '^\.decisions/.*\.md$' | while IFS= read -r adr; do
  [ -z "$adr" ] && continue
  # Capture and CHECK the body before probing, never a straight pipe — `gh` writes its error document
  # to STDOUT, so a pipe hands the probe an ERROR BODY to classify as the ADR (§CPREAD #2, #4216).
  adr_body="$(gh api "repos/$REPO/contents/$adr?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' 2>/dev/null)" || adr_body=""
  if [ -z "$adr_body" ]; then
    echo "BLOCKING ($adr — ADR body unreadable ⇒ §CP UNKNOWN, held)"
  else
    GC_STATE="$(printf '%s' "$adr_body" | "$PCLI" guard-content-probe classify --path "$adr" 2>/dev/null)"
    case "$GC_STATE" in
      not-guard-touching) : ;;   # proven ordinary — the ONLY value that may skip the hold
      guard-touching) echo "BLOCKING ($adr — guard-touching ADR ⇒ §CP, ADR 0164)" ;;
      *) echo "BLOCKING ($adr — probe UNDETERMINED (state '$GC_STATE') ⇒ §CP, fail-closed)" ;;
    esac
  fi
done
```

**`… && echo BLOCKING` is UNSAFE and must not be reintroduced.** It emits nothing when the
verb never ran — a bad flag (exit 1), a typo'd subcommand (1), a module-not-found from a
nested cwd (1), a missing shim (127) — so an unprobed ADR is recorded as ordinary. That
fail-open shape was published here and copied by every gate until
[#4219](https://github.com/kamp-us/phoenix/issues/4219); `command.test.ts` pins both the
verdict codes and the invocation failures so it cannot come back.
