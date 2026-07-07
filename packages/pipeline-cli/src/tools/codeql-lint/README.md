# codeql-lint

`pipeline-cli codeql-lint check [--root <d>]` — a deterministic, local, author-time
approximation of the two **common** CodeQL findings that keep blocking net-new-artifact
PRs at ship (issue #2261). It shifts those findings LEFT: they fail the push (or a manual
run) instead of surfacing late as a CodeQL alert that refuses the PR at ship and costs a
full repair → re-review → re-ship cycle.

It is **not** CodeQL and makes **no network call** — it is a fast static check
(~1s over the whole repo) for the two well-known *shapes*:

1. **workflow-permissions** — CodeQL's *"Workflow does not contain permissions"* (PR
   #2251). A GitHub Actions workflow whose `GITHUB_TOKEN` scope is not pinned
   least-privilege. A workflow PASSES iff it declares an explicit `permissions:` block at
   the **top level** or on **every job**; otherwise it FAILS. The fix is the merged
   precedent — an explicit least-privilege block:

   ```yaml
   permissions:
     contents: read
   ```

2. **redos** — CodeQL's *"Polynomial/exponential regular expression on uncontrolled data"*
   (PR #2258). A regex whose structure admits catastrophic backtracking. Two textbook
   shapes are flagged, chosen to be unambiguous and **low-false-positive**:
   - **nested quantifier** — an unbounded-quantified group whose body is *exactly* a
     single unbounded-quantified atom: `(a+)+`, `(a*)*`, `([a-z]+)*`, `(\d+){2,}`.
   - **quantified/overlapping alternation** — an unbounded-quantified group whose body
     has a top-level `|` where a branch is a single unbounded-quantified atom (`(a+|b)*`)
     or two branches are identical (`(a|a)+`).

   The *"single quantified atom"* condition is load-bearing: it is what makes the
   catastrophe real (inner and outer quantifiers matching the same input ambiguously). A
   group that merely *ends* in a quantifier but has a mandatory disambiguating prefix —
   the standard kebab/slug `(-[a-z0-9]+)*`, each iteration forced to start with a literal
   `-` — is **linear**, not catastrophic, and is deliberately **not** flagged (CodeQL does
   not flag it either).

## Scope (documented, no silent caps — the scan surface is logged to stderr)

- **workflows:** `.github/workflows/*.{yml,yaml}`.
- **source (regex scan):** `.ts/.tsx/.js/.jsx/.mjs/.cjs` under `apps/`, `packages/`,
  `infra/`, skipping `node_modules`, `dist`, `build`, `coverage`, `.git`, `tests`/
  `__tests__` dirs, and any `*.d.ts` / `*.test.*` / `*.spec.*` file. Test files are out
  of scope on purpose: ReDoS-on-uncontrolled-data is a runtime-path concern, and a test
  may legitimately carry an adversarial regex fixture (this tool's own tests do).
  Template-literal `RegExp` args are out of scope (rare).

## The grandfather baseline

`.github/codeql-lint-baseline.json` grandfathers the **pre-existing** debt CodeQL
default-setup already carries as unrelated alerts, so `check` is **green on `main`** and
fails only on **new** violations — the whole point is to block net-new artifacts, not to
boil the ocean on legacy workflows (the design-token-guard config model).

```json
{
  "grandfatheredWorkflows": [".github/workflows/ci.yml", "…"],
  "grandfatheredRegexes": [{"path": "…", "pattern": "…"}]
}
```

Do **not** add a *new* workflow here to dodge the gate — add a `permissions:` block
instead. The list only shrinks, as legacy workflows get pinned. A missing baseline is the
strictest posture (nothing grandfathered); a present-but-malformed baseline **fails
closed** (ADR 0092).

## Exit-code contract

A **dedicated** gate-fail code (the `leak-guard` = 2 / `ref-guard` = 3 idiom):

- `0` — clean.
- `2` — a real finding (a workflow missing permissions / a catastrophic regex).
- any **other** non-zero (`1`, `127`, the #1798 unlinked-dep remediation) — the check
  could not **run**.

The `lefthook` pre-push leg keys off code `2` to **fail-closed on a finding** but
**fail-open on an absent toolchain** — so a lean/stripped-PATH worktree is never bricked.
CodeQL's own CI scan stays the backstop.

## Design

- `codeql-lint.ts` — the **pure, IO-free** core: the ReDoS shape detector (`detectRedos`),
  the comment/string-aware regex extractor (`extractRegexes`), the workflow-permissions
  parser/judge, and the top-level `judge` (+ grandfather filtering). Unit-tested over
  strings/facts with no disk (`codeql-lint.unit.test.ts`).
- `gate.ts` — the **filesystem seam**: walk the workflow + source roots, read the
  baseline, delegate to the core. Crossed over a fake temp tree in `gate.unit.test.ts`.
- `command.ts` — the thin `effect/unstable/cli` wiring (mirrors `design-token-guard`).

Fails closed on zero scope (ADR 0092): zero workflows **and** zero source files is a wrong
root, not a vacuous pass.
