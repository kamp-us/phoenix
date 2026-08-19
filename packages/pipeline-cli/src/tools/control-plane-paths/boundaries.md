# §CP boundary wire lines

The un-importable prose copy of the classification boundaries the shell-side callers read
(`grep`/`sed`, not `import`). It lived in the v1 formats doc
(`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`) until the kampus-pipeline
plugin retired (#5937); the lines moved here — inside the §CP `control-plane-paths/` tree — with
their contracts unchanged:

- `CONTROL_PLANE_RE` is kept byte-equal to the single-source const in
  [`control-plane-re.ts`](control-plane-re.ts) by `pipeline-cli codeowners-cp check` (the
  `codeowners-cp.yml` job) — fail-closed on any divergence (#2761). The anti-self-authorization
  read (#981) still holds: `cp-classify` and `trivial-diff` fetch this file at `ref=main`, so a
  boundary-editing PR is classified against MAIN's boundary, never its own edit.
- `GUARD_ADR_RE` is `guard-content-probe`'s ADR-0164 content probe over `.decisions/**` text; a
  failed read falls back to the fail-closed match-everything `'.'` (⇒ §CP).

```
CONTROL_PLANE_RE='^(\.claude|\.github)/|^\.claude-plugin/|^packages/ci-required/|^packages/fabrika-cli/src/ci/|^packages/pipeline-cli/src/[^/]+$|^packages/pipeline-cli/src/tools/(ci-required|codeowners-cp|control-plane-paths|cp-cardinality|cp-classify|review-head|trivial-diff|verdict)/|^packages/pipeline-cli/src/tools/tracker/gh-io\.ts$|^biome\.jsonc$|^biome-plugins/|^([^/]+/)*(lefthook|\.lefthook)[^/]+$'
```

```
GUARD_ADR_RE='guard|invariant|fail-closed|fail-open|fail closed|fail open|containment|control-plane|control plane|§cp|self-weakening|blocking set|adversarial review|must never|hard-gate|hard gate|enforcement|\bgat(e|es|ing|ed)\b|relax|loosen|weaken|soften|widen|broaden|waive|bypass|exempt|carve[ -]?out|opt[ -]?out'
```
