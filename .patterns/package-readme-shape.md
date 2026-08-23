# package-readme-shape — the canonical `packages/*/README.md` section order

> Forged against real READMEs (`cf-credentials`, `composer`, `depo`, `fate-effect`) rather than declared in the abstract. The `diataxis` skill is the classifier that checks a page holds one mode; this doc states the shape it classifies against.

Every `packages/*/README.md` follows one section order, scaled to README size:

```text
# <package name>
## What it is          ← explanation
## Why it exists       ← explanation (the ADR that forced the package)
## How to use it       ← how-to (runnable commands, import-and-call)
## Reference           ← reference last or linked out (exports, flags, config keys)
## Testing             ← a short testing tail
```

## The rules that make it checkable

1. **Explanation first.** A reader decides whether to care before they decide how to act. *What it is* names the thing in one paragraph; *why it exists* cites the decision that forced it (an ADR number, an incident) instead of re-arguing the why.
2. **No tutorial at package scale.** A step-by-step walkthrough ("build your first X", numbered lessons followed start to finish) never blends into the README — it moves to its own linked surface next to the package. A README is mid-task material; a tutorial is study material. The two modes on one page serve neither reader ([diataxis](../../claude-plugins/fabrika/skills/diataxis/SKILL.md)).
3. **Scope and non-goals live in the explanation half.** What the package deliberately does not cover is a *why-it-exists* concern, stated once up front — not scattered through reference sections as apologies.
4. **How-to is recipes, not lessons.** Each how-to entry targets one real result (run this command, call this export), assumes competence, and links out for the concepts behind it.
5. **Reference is dry and complete.** Exports, flags, config keys, module maps — look-it-up tables matching the code's structure, at the tail or on a linked page. No persuasion, no narration.
6. **Small-package minimum.** A small package may satisfy the whole shape in three short sections (*What it is* carrying the why, *How to use it*, *Testing*) — the order is canonical, the length is not.

## The mode contract

One README serves one dominant mode at a time per section, and the sections appear in explanation → how-to → reference order. When a draft reads like it wanders, run the `diataxis` classification over it: a single dominant mode with no unresolved type-mixing flag is the pass condition. Rewriting a flagged page is `build`'s job, not the classifier's.

## See also

- [index.md](./index.md) — the pattern library front door
- [diataxis skill](../../claude-plugins/fabrika/skills/diataxis/SKILL.md) — the single-mode classifier
