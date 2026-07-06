# design-token-guard

`pipeline-cli design-token-guard check` — the first deterministic enforcement rung of
the four-pillars design law (issue
[#2170](https://github.com/kamp-us/phoenix/issues/2170), ADR
[0162](../../../../../.decisions/0162-four-pillars-design-law.md) /
[design-system-manifest.md](../../../../../design-system-manifest.md)). It fails the
build when a component CSS file bypasses the design-token seam — the recurrence guard
for the class of defect [#2167](https://github.com/kamp-us/phoenix/issues/2167) fixed
(the Toast `var(--surface-1)`/`var(--text)` dead refs).

## What it enforces

Scanning every `apps/web/src/**/*.css`, three checks:

1. **undefined-ref** — every `var(--…)` must resolve to a custom property declared
   somewhere in the CSS corpus (the `tokens.css` role layer, `global.css` focus tokens,
   or a component-local `--x:`), OR a runtime-injected property (`externalProperties`),
   OR a grandfathered dead ref (`grandfatheredMissingTokens`). A ref to none of those
   fails. This is exactly what would have caught Toast's dead refs. Resolution is
   corpus-wide (CSS custom properties cascade from any declaration, not just
   `tokens.css`), so `--focus-ring` (declared in `global.css`) and component-local vars
   resolve without a false positive.
2. **raw-hex** — a component CSS file carries no hex color literal. Hex lives **only**
   in the raw-scale layer `apps/web/src/styles/tokens.css` by law
   (design-system-manifest.md, Pillar 2); a component reaches for a role token.
   Issue-ref comments like `/* #2169 */` are stripped before matching, so only real hex
   colors count.
3. **raw-px ratchet** — a file's count of raw `px` values `> 2px` must not exceed its
   per-file ceiling. The 4px grid sanctions only `1px` & `2px` (hairlines, optical
   nudges — ADR 0162 value #1); everything else lands on the `--s-N` spacing ramp.
   `@media`/`@container`/`@supports` breakpoint values are excluded.

Fail-closed on zero CSS files or a malformed config (ADR
[0092](../../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)).

## How it avoids red-walling the existing tree

The frontend audit catalogued ~263 pre-existing raw-px sites and a handful of dead refs.
A blocking lint that failed on all of them would red-wall the repo. Instead, three
**bounded, documented allow-lists** in
[`apps/web/src/styles/design-token-lint.config.json`](../../../../../apps/web/src/styles/design-token-lint.config.json)
grandfather that existing debt so the gate is **green on `main`** while still failing on
any **new** bypass:

- `externalProperties` — names injected at runtime (Base UI's
  `--collapsible-panel-height`, our own `--swatch-color`), which have no CSS declaration.
- `grandfatheredMissingTokens` — pre-existing dead refs, grandfathered **by name** (not
  line), so a **new distinct** dead ref still fails. This list only shrinks: the
  token-recalibration / primitive legs
  ([#2163](https://github.com/kamp-us/phoenix/issues/2163)/[#2166](https://github.com/kamp-us/phoenix/issues/2166))
  remove a name as they fix the ref.
- `rawPxCeilings` — a per-file ceiling. A file **over** its ceiling fails (a regression /
  new raw-px debt); a file **not listed** must be raw-px clean; an improvement passes.
  After a genuine cleanup leg, regenerate with `--write-baseline`.

Raw hex is zero-tolerance (the single pre-existing site was fixed in the landing PR), so
it carries no allow-list — the raw layer `tokens.css` is its only sanctioned home.

## Usage

```bash
pipeline-cli design-token-guard check                  # the CI gate (exit non-zero on any seam break / zero scope)
pipeline-cli design-token-guard check --root <dir>     # scan a specific repo root (default: walk up for one)
pipeline-cli design-token-guard check --write-baseline # regenerate rawPxCeilings from the current tree, then pass
```

Wired as the always-on `.github/workflows/design-token-guard.yml` gate (the
`readme-guard` / `fanout-guard` idiom). The pure core + IO seam live in
`design-token-guard.ts` / `gate.ts`; the pure verdict + parsers are unit-tested in
`design-token-guard.unit.test.ts`, the filesystem gate in `gate.unit.test.ts`.

```bash
pnpm --filter @kampus/pipeline-cli test    # vitest over the core + gate
```
