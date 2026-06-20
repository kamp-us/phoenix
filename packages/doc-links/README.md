# @kampus/doc-links

Repo-wide **dead-internal-link gate** for docs (#638).

`review-doc` is PR-scoped: it only checks links in the docs a PR *changes*, so a
file rename/delete silently orphans links in any doc *outside* that PR's diff, and
nothing re-checks the rest of the tree. This gate closes that gap — it walks every
git-tracked `.md` and fails the build if a relative/internal link points at a path
that no longer resolves on disk.

```bash
node packages/doc-links/src/bin.ts check          # CI gate: exit non-zero on any dead internal link
node packages/doc-links/src/bin.ts check --root .  # scan a specific repo root
```

## What it checks

- Every git-tracked `*.md` file in the repo.
- Only **internal** markdown links `[text](target)` — relative paths and repo-root
  absolute paths (`/foo`). External targets (`http(s):`, `mailto:`, `tel:`), bare
  `#fragments`, and protocol-relative `//host` links are skipped.
- A target's `#fragment` / `?query` is stripped before resolution; only the file
  path must exist (no anchor-fragment validation — that is out of scope, #638).

## What it ignores (and why)

Links written **inside inline code spans (`` `…` ``) or fenced code blocks** are
not links per markdown semantics — they are the literal text docs use to *show*
link syntax (CLAUDE.md's `` `[text](relative/path.md)` `` convention note, the
`/adr` template's `[NNNN](NNNN-slug.md)` placeholder). Masking code is what keeps
the gate from flagging those intentional examples; it is a correctness rule, not
an allowlist. Wrap an intentional example in backticks and the gate leaves it alone.

## Shape

A pure, IO-free core (`doc-links.ts`: link extraction, code masking, dead-link
derivation) + an Effect-CLI bin (`bin.ts`) that wires it to the filesystem via the
IO gate (`gate.ts`). Same idiom as `@kampus/decisions-index` / `@kampus/leak-guard`
(`effect/unstable/cli`, `NodeRuntime.runMain`). Wired into CI as a standalone
workflow (`.github/workflows/doc-links.yml`).

Exit codes: `0` clean, non-zero on a dead link (report on stderr) or an IO failure
— undistinguished, both are failures.
