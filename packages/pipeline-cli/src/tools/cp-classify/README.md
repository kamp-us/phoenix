# `cp-classify` — the §CP entry point that cannot fail open

`pipeline-cli cp-classify classify` answers "is this change control plane?" over a changed-file
set **without ever handing back a fail-open "no"**.

## Why it exists

§CP membership has **two independent sources**:

1. the path regex `CONTROL_PLANE_RE` (single-sourced in
   [`../control-plane-paths/control-plane-re.ts`](../control-plane-paths/control-plane-re.ts), #2761), and
2. the ADR-0164 **content** probe over touched `.decisions/**` ADRs
   ([`../guard-content-probe/`](../guard-content-probe/)).

A site that consulted only the path regex read "no path matched" as the authoritative "this is
ordinary work". That is wrong for the exact shape that matters — a guard-touching ADR is §CP by
content with **zero** path matches (live instance: PR #4134, both files `.decisions/**`) — and it
is wrong in the **fail-open** direction: the guard-relaxing change routes as product work and
escapes the human control-plane approval. `CONTROL_PLANE_RE` has no `.decisions/` clause, so a
path-only test classifies *every* ADR non-§CP (#4161).

This verb makes the path-only answer **unrepresentable as a verdict**.

## The four states

| stdout word | meaning | exit |
| --- | --- | --- |
| `control-plane` | a path matched the live boundary — authoritative §CP | 0 |
| `content-undetermined` | no path matched, but `.decisions/**` files are present — **an obligation, not a verdict**: probe each with `guard-content-probe` before claiming ordinary | 0 |
| `not-control-plane` | path clear **and** no `.decisions/**` file, so the content clause has nothing to decide — the one proven-ordinary verdict | 3 |
| `unknown` | the classification could not be made (unresolvable/uncompilable boundary, empty file set) — treat as §CP and hold | 0 |

`unknown` is deliberately its own state. A read that failed and a change that is genuinely
non-§CP are **different facts**; collapsing them is the recurring fail-open defect class in this
repo (#3715, #4108, #4171, #4191).

## How to call this safely — assert on the state word, never on a bare non-zero

The exit code discriminates the four states **only once the verb has run.** It cannot tell you
*whether* it ran, and the verb not running is not hypothetical here — a bare `pipeline-cli` exits
**127** when the shim is off `PATH`. Observed, at this head:

| invocation | exit | stdout |
| --- | --- | --- |
| a hold state (`control-plane` / `content-undetermined` / `unknown`) | 0 | the state word |
| `not-control-plane` | 3 | `not-control-plane` |
| unread stdin (`STDIN_READ_FAILED_EXIT_CODE`, #3924) | 4 | *(empty)* |
| a bad flag (`BAD_INVOCATION_EXIT_CODE`, #5072) | 4 | the help text — **no state word** |
| a missing binary | 127 | *(empty)* |

**The sanctioned idiom is a positive match on the stdout state word** — what all three rewired
gates (`review-design`, `review-skill`, `review-trivial`) already do. Only that shape is proof:

```bash
CP_STATE="$(… | pipeline-cli cp-classify classify --repo "$REPO")"
if [ "$CP_STATE" = "not-control-plane" ]; then
  : # proven ordinary — the ONLY branch that may skip the §CP hold
else
  echo "BLOCKING (§CP state '$CP_STATE')"   # every other value, INCLUDING the empty string a failed invocation yields
fi
```

**Both naive exit-status shapes are UNSAFE. Do not use them:**

```bash
… | pipeline-cli cp-classify classify --repo "$REPO" || echo "ordinary"   # UNSAFE — fires on 1 and 127 too
… | pipeline-cli cp-classify classify --repo "$REPO" && echo "BLOCKING"   # UNSAFE — emits nothing when the verb never ran
```

`||` treats *every* non-zero as the ordinary verdict, so a bad flag or a missing binary routes a
§CP change to the ordinary branch; `&&` simply stays silent, so the BLOCKING line the caller was
relying on never appears. Both fail **open**.

`not-control-plane` therefore carries its own exit code, **3** — one that neither a malformed
invocation (4) nor a missing binary (127) nor an unread stdin (4) produces. An exact
`[ "$rc" -eq 3 ]` test is positive proof; `[ "$rc" -ne 0 ]` is not. This is the
`STDIN_READ_FAILED_EXIT_CODE` convention (`../../read-stdin.ts`, #3924) applied to the verdict
itself: *"the tool never ran"* must never be readable as an answer. Note that a pipe hides the
verb's status entirely unless `set -o pipefail` is on — capture stdout, as above, and test that.

## Usage

```bash
# the canonical PR-file-set classification (paginated + streaming --jq, one path per line)
gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename' \
  | pipeline-cli cp-classify classify --repo "$REPO"

# classify against a boundary you already resolved from origin/main
pipeline-cli cp-classify classify --files-file changed.txt --control-plane-re "$CONTROL_PLANE_RE"
```

With no `--control-plane-re`, the boundary is re-resolved from `gh-issue-intake-formats.md` on
**`origin/main`** (`?ref=main`) — the anti-self-authorization read (#981), so a boundary-editing
PR is classified against main's boundary, never its own edit. A failed resolution yields
`unknown`, never a fallback to the in-tree const.

## Resolving `content-undetermined`

Run the existing ADR-0164 probe over each listed ADR at the PR head; nothing about that probe
changes here, so this verb widens no over-match (#2617):

```bash
cp_head_sha "$REPO" "$PR"; HEAD_SHA="$CP_HEAD_SHA"   # §CPREAD: EMPTY on a failed read, payload discarded
# Capture and CHECK the body, never a straight pipe — `gh` writes its error document to stdout (#4216).
adr_body="$(gh api "repos/$REPO/contents/$adr?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' 2>/dev/null)" || adr_body=""
GC_STATE="$([ -n "$adr_body" ] && printf '%s' "$adr_body" | pipeline-cli guard-content-probe classify --path "$adr" 2>/dev/null)"
[ "$GC_STATE" = "not-guard-touching" ] || echo "BLOCKING ($adr — state '$GC_STATE')"
```

That probe's exit contract is this one's: proven-ordinary owns
[`PROVEN_ORDINARY_EXIT_CODE`](../../exit-codes.ts), so the state-word assertion above is what
keeps a failure to invoke out of the ordinary branch — see
[`../guard-content-probe/README.md`](../guard-content-probe/README.md#how-to-call-this-safely).

## Shape

Pure core (`cp-classify.ts`) + thin Effect bin (`command.ts`), the repo's mechanical-tooling
idiom. The core also owns `CP_CONTENT_PREFIX` / `isContentClassifiedPath` — the single definition
of *which paths the content clause is scoped to* — which `trivial-diff` imports rather than
re-declaring.

The register of every §CP-classification site and which sources each consults lives in
`gh-issue-intake-formats.md` §CP.
