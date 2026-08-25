# Diátaxis-lite README shape

The canonical section order every `packages/*/README.md` follows, scaled to package size.
Grounded in the shape the repo converged on: [`packages/cf-credentials/README.md`](../packages/cf-credentials/README.md),
[`packages/composer/README.md`](../packages/composer/README.md), [`packages/depo/README.md`](../packages/depo/README.md).
The `diataxis` skill is the classifier that checks a page holds one dominant mode; this doc is
the README-sized projection of that law.

## The canonical section order

1. **`# @kampus/<name>`** — one-line identity: what the package is in a sentence.
2. **`## What it is`** — explanation. The surfaces a consumer touches, named file-by-file or
   export-by-export. This is the *reference-adjacent* half: concrete, checkable against source.
3. **`## Why it exists`** — explanation. The forcing constraint or decision that minted the
   package, citing the ADR (and the "promote at the 2nd usage" trigger where it applies).
   Scope and non-goals live here — in the explanation half, never buried in a how-to step.
4. **`## How to use it`** — how-to. The runnable commands and the import-and-call snippet a
   consumer needs. No narrative arc; if it needs steps 1-through-6 with prose between, that is
   a tutorial and belongs on its own linked surface.
5. **Reference tail** — tables of rules/invariants, module maps, config keys, flags. Last
   section(s), or linked out to a dedicated page when they outgrow the README.
6. **`## Testing`** — short tail: how to run this package's tests, anything surprising about
   them.

A small package may satisfy the shape in three short sections (`What it is`, `How to use it`,
`Testing`) — the minimum is that explanation leads and reference trails.

## The rules that make it checkable

- **No tutorial at package scale.** A numbered walkthrough with narrative between steps moves
  to its own linked surface (e.g. `WALKTHROUGH.md` beside the README), referenced from
  *How to use it* — never blended into the README body.
- **Scope and non-goals live in the explanation half** (*What it is* / *Why it exists*). A
  reader deciding "is this for me?" should not have to parse a how-to to find the boundary.
- **Every behavioural claim must verify against source at the PR's head.** Commands run,
  exports exist, behaviours hold. The additive truth rule: each public surface introduced
  since the README's last truth pass is either described or explicitly named as out of scope.
- **One dominant mode per section.** Explanation sections explain; how-to sections instruct;
  reference sections enumerate. The `diataxis` skill flags type-mixing.

## Applying it to an existing README

Re-ground before restructuring: diff the README's claims against `src/**` at head (the
drift window = commits touching the package after the README's last touch), then reorder into
the canonical order, moving any walkthrough to its own surface and demoting stale claims.
Worked example: [`packages/fate-effect/README.md`](../packages/fate-effect/README.md).
