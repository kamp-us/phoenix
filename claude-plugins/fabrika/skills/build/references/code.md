# Surface rubric — code

Compiled, tested text. `fabrika build check` runs the commands this repo declares under
`.fabrika.jsonc`'s `codeValidators` in this tree — typically a typecheck and a lint, whatever the
repo named. A repo that declares none refuses UNKNOWN rather than running someone else's script
names.

- **Match the surrounding code's idiom** — comment density, naming, bracket style. A diff that
  reads as a different author is a defect before it is a style choice.
- **Comments earn their place or die.** The *why* belongs in the repo's decision records, the shape
  in its pattern docs; an inline comment is the surface of last resort. Never narrate control flow,
  never address the reviewer.
- **Make invalid states unrepresentable; domain logic in domain objects.** Prefer a type that
  cannot hold the bug over a check that catches it.
- **Ground platform/dependency behavior in source, not intuition** — the dependency's own source or
  its documented idiom, never recall. Where a framework publishes an agent-facing idiom file, that
  file wins over a cleaner-looking instinct. Cite what you grounded in the PR body.
- **Honour the repo's own standing guards.** `fabrika guard --help` lists what this repo reds on —
  dependency-version policy, fan-out publication, copy placement, and whatever else it has added.
  A rule a guard enforces is part of this rubric wherever the guard is installed; read the guard
  rather than guessing its scope.
- **Tests ride the change**: unit beside the module, integration where the seam is the subject.
  Deleting a failing test is never a fix — a red test is a claim about the code, and removing the
  claim leaves the defect.
