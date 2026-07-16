# Dependency patch behavior pins

The canonical definition site for the **"patch behavior-pin"** vocabulary and the
two-layer discipline the `patch-guard` gate enforces. Read this before adding, bumping,
or removing a `pnpm patch`.

## Why patches need a pin

A `pnpm patch` ([ADR 0038](../.decisions/0038-dependency-patches-local-only.md)) is a
**silent fork of a dependency's behavior**: the patch changes what the dep does at
runtime, but nothing in the repo asserts *that* the changed behavior holds. When the dep
is later bumped and the patch is re-generated (or dropped), the behavior it encoded can
regress with no test going red — the fork rots invisibly. The forcing function is a
**behavior pin**: a test that fails if the patched behavior regresses, so the patch is
never carried without something verifying it.

## The two-layer discipline

Every maintained patch is held by two independent layers, and both must be present:

1. **Version-keyed loud-fail** — the patch is registered in `patchedDependencies` in
   `pnpm-workspace.yaml` under a `<name>@<version>` key. pnpm itself fails loudly if the
   installed version drifts from the patched version, forcing a conscious re-generate on
   every bump. This layer is pnpm's, not ours.
2. **Behavior pin** — a test that exercises the patched behavior and fails if it
   regresses, self-registering with a marker comment (below) keyed to the exact
   `patchedDependencies` entry. This layer is `patch-guard`'s.

Layer 1 catches *version* drift; layer 2 catches *behavior* drift. A patch with only
layer 1 is a fork nothing verifies — exactly what `patch-guard` fails closed on.

## The marker grammar

A behavior-pinning test self-registers with a single-line comment marker:

```
// @patch-pin: <name>@<version>
```

- `<name>@<version>` is the **exact** `patchedDependencies` key it pins (e.g.
  `@nkzw/fate@1.3.1`, `alchemy@2.0.0-beta.59`, `react-fate@1.3.1`). A scoped name keeps
  its leading `@`; the version is the substring after the final `@`.
- The marker lives in a **test file** (`*.test.ts` / `*.test.tsx`, any tier). `patch-guard`
  only scans the test tree — a marker in a non-test file does not register.
- **≥1** marker per patched dep is required; more than one is fine (a patch may be pinned
  by several tests).
- The marker is matched anywhere in a comment; both `//` and `/* … */` forms work.

## What `patch-guard` enforces (fail-closed)

`pipeline-cli patch-guard check` (CI job `.github/workflows/patch-guard.yml`) reads the
`patchedDependencies` map and every `@patch-pin:` marker across the test tree, and **fails
closed** ([ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md)) on:

- **A patched dep with no matching pin** — a maintained patch whose behavior nothing
  verifies. Fix: add a test that fails if the patched behavior regresses and tag it.
- **A stale pin** — a marker naming a `name@version` **not** in `patchedDependencies`
  (the patch was dropped or its version bumped without updating the pin). Fix: update the
  marker to the current key, or delete the orphaned pin.
- **Zero scope** — no `patchedDependencies` found at all (a mis-scope: wrong root or a
  moved workspace file). A mis-scope reds, never silently passes.

The guard scans only *this* checkout's test tree; `node_modules`, `.git`, `.claude`
(nested agent worktrees), and build output are skipped.

## Scales to future patches by construction

The guard is keyed on `patchedDependencies`, so it covers any patch added later with no
guard change. When the planned `effect` patch lands (issue #3053, epic #3045) it adds
`effect` to `patchedDependencies` and carries a `// @patch-pin: effect@<version>` test —
`patch-guard` then enforces it automatically, the same as the three patches maintained
today. Adding a patch without its pin is precisely the state the guard fails closed on.
