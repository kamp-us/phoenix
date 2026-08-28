# package-readme-shape — the canonical `packages/*/README.md` section order

Use the [`diataxis` skill](../claude-plugins/fabrika/skills/diataxis/SKILL.md) to classify the README
before applying this shape. A README has one dominant mode; entries for other reader needs link to
their own pages instead of embedding a second mode.

## Canonical order

```text
# <package name>
## What it is          ← explanation, or a link to the explanation home
## Why it exists       ← explanation, or links to the governing ADRs
## How to use it       ← how-to recipes
## Reference           ← reference content or a link to the reference page
## Testing             ← short task-oriented validation commands
```

The navigation order is explanation → how-to → reference → testing even when the README's dominant
mode moves some entries to linked pages.

## Rules

1. **Explanation first.** State what the package is and point to the decision that forced it. Do not
   re-argue an ADR in the README.
2. **No tutorial at package scale.** Move every start-to-finish lesson to a linked tutorial next to
   the package.
3. **Scope and non-goals live in the explanation half.** State them once on the explanation surface.
4. **How-to is recipes, not lessons.** Each recipe targets one result and assumes competence.
5. **Reference is dry and complete.** Keep exports, flags, configuration keys, and module maps on a
   reference surface at the tail or on a linked page.
6. **Small-package minimum.** A small package may use three short entries: what/why, how to use it,
   and testing.
7. **One dominant mode.** A page that answers more than one reader need must split; section labels do
   not make a mixed page single-mode.

## Classification contract

Record one dominant mode with no unresolved type-mixing flag. The `diataxis` skill classifies; a
`build` repair splits any mixed page it reports.

## See also

- [Pattern library index](./index.md)
- [`diataxis` classifier](../claude-plugins/fabrika/skills/diataxis/SKILL.md)
