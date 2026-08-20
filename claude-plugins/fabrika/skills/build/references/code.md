# Surface rubric — code

Compiled, tested text. `fabrika build check` runs the commands this repo declares under
`.fabrika.jsonc`'s `codeValidators` here, cache-bypassed, in this tree — in phoenix, the pair it
declares there, `pnpm typecheck --force` and `pnpm lint:worktree`. A repo that declares none refuses
UNKNOWN rather than running someone else's script names.

- **Match the surrounding code's idiom** — comment density, naming, bracket style. A diff that
  reads as a different author is a defect before it is a style choice.
- **Comments earn their place or die.** The *why* belongs in `.decisions/`, the shape in
  `.patterns/`; an inline comment is the surface of last resort (CLAUDE.md). Never narrate control
  flow, never address the reviewer.
- **Make invalid states unrepresentable; domain logic in domain objects.** Prefer a type that
  cannot hold the bug over a check that catches it.
- **Ground platform/dependency behavior in source, not intuition** — effect-smol's `LLMS.md` for
  Effect idiom; the dep's own source for its contract. Cite what you grounded in the PR body.
- **Every dependency via `catalog:`** — never a hardcoded version (catalog-guard reds it anyway).
- **A mutation over a fate-live fanned entity publishes the `/fate/live` invalidation** — check
  `apps/web/worker/features/fate-live/fanned-mutations.ts` before touching Post/Comment/Definition
  writes (fanout-guard reds the omission).
- **Tests ride the change**: unit beside the module, integration where the seam is the subject.
  Deleting a failing test is never a fix (#4111).
