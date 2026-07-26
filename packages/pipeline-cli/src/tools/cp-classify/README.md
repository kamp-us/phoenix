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
| `not-control-plane` | path clear **and** no `.decisions/**` file, so the content clause has nothing to decide — the one proven-ordinary verdict | 1 |
| `unknown` | the classification could not be made (unresolvable/uncompilable boundary, empty file set) — treat as §CP and hold | 0 |

`unknown` is deliberately its own state. A read that failed and a change that is genuinely
non-§CP are **different facts**; collapsing them is the recurring fail-open defect class in this
repo (#3715, #4108, #4171, #4191).

**The exit code is fail-closed in both bash idioms.** It is 0 on every hold state and 1 only on
`not-control-plane`, so:

```bash
… | pipeline-cli cp-classify classify --repo "$REPO" && echo "BLOCKING"    # holds on §CP, undetermined, unknown
… | pipeline-cli cp-classify classify --repo "$REPO" || echo "ordinary"    # ordinary only on positive proof
```

Neither shape can silently fail open — which matters, because those are exactly the shapes the
path-only sites reached for.

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
HEAD_SHA="$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha')"
gh api "repos/$REPO/contents/$adr?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' \
  | pipeline-cli guard-content-probe classify --path "$adr" >/dev/null && echo "BLOCKING ($adr)"
```

## Shape

Pure core (`cp-classify.ts`) + thin Effect bin (`command.ts`), the repo's mechanical-tooling
idiom. The core also owns `CP_CONTENT_PREFIX` / `isContentClassifiedPath` — the single definition
of *which paths the content clause is scoped to* — which `trivial-diff` imports rather than
re-declaring.

The register of every §CP-classification site and which sources each consults lives in
`gh-issue-intake-formats.md` §CP.
