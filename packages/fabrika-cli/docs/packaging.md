# fabrika-cli packaging and delivery

Reference facts about how `@kampus/fabrika-cli` is published and which copy of the binary serves an
invocation. The decision behind the delegation boundary is
[ADR 0287](../../../.decisions/0287-delegation-stays-inside-one-repository.md); the recipes for
confirming a copy or silencing a warning are in
[running fabrika in a repo](./running-fabrika-in-a-repo.md).

## Which copy serves an invocation

`fabrika` is installed globally once. On startup the binary finds the repo root above the working
directory, asks Node's resolver what copy of `@kampus/fabrika-cli` that root has installed, and
hands the invocation to it.

| Where you are | What runs | Warning |
| --- | --- | --- |
| In phoenix | the working tree — `packages/fabrika-cli` | — |
| In a **git worktree** of phoenix | that worktree's `packages/fabrika-cli` | — |
| In a consumer repo that installed it | that repo's pinned version | — |
| In a consumer repo that did **not** install it | the global | yes, naming both versions |
| In no repo at all | the global | no |
| Running a copy from a **different repository** by path | nothing — it refuses, exit `126` | yes, naming both checkouts |

Four behaviours produce those rows:

- A copy invoked by path from another repository is refused rather than delegated to. `--skip-infer`
  makes the copy you named serve the invocation instead.
- Worktrees of one repository delegate to each other. The comparison is the repository: two trees'
  `$GIT_COMMON_DIR` is read off disk and equal common dirs delegate. A tree whose repository cannot
  be established counts as a different one.
- A resolved install must live at or under the repo root. Node falls back to `NODE_PATH` after the
  `node_modules` walk, and pnpm's global shim exports a `NODE_PATH` chain rooted at the checkout it
  was installed from, so anything resolved outside the repo is `absent` whatever Node found.
- Two recursion guards are read before any filesystem work: the parent passes `--skip-infer` to the
  child (stripped before any verb sees it), and `FABRIKA_SKIP_INFER` does the same for a caller that
  cannot alter argv.

The child's cwd is the repo root, not yours; your cwd travels as `FABRIKA_INVOCATION_DIR`.

| Variable | Effect |
| --- | --- |
| `FABRIKA_DEBUG=1` | prints one stderr line naming which copy served the invocation |
| `FABRIKA_GLOBAL_WARNING_DISABLED=1` | silences the ran-the-global warning |
| `FABRIKA_SKIP_INFER` | skips delegation, as `--skip-infer` does |
| `FABRIKA_INVOCATION_DIR` | set by the parent to the caller's cwd |

phoenix carries `@kampus/fabrika-cli` in its root `devDependencies`, so a bare `fabrika` in a
phoenix checkout runs the working tree: edit `src/`, and the next invocation runs the edit.

## The two Node floors

The two entry points need different Nodes, so the manifest carries two floors:

| Floor | Where it lives | What it is | Who reads it |
| --- | --- | --- | --- |
| `>=22.12` | `publishConfig.engines.node` | what the compiled `dist/` runs on | consumers, via the tarball |
| `>=24` | top-level `engines.node` | what the `.ts` `bin` needs for type stripping | this workspace |

`>=22.12` is measured: `dist/bin.js` is clean on 22.12 and up, warns on 22.11
(`ExperimentalWarning: Importing JSON modules`), and throws on Node 20 and 18, where `undici`'s
`webidl.util.markAsUncloneable` does not exist. The workspace floor `>=24` is conservative — the
`.ts` `bin` starts on 22.18+ — and `volta.node` pins `26.2.0` here and at the repo root.

## `publishConfig` and the published tarball

Node refuses to strip types for any file under `node_modules`, so a `.ts` `bin` cannot start from an
installed copy. `publishConfig` is what lets both entry points ship from one manifest: `bin` stays
`./src/bin.ts` for the workspace, where pnpm's link resolves outside `node_modules`, and npm rewrites
`bin` / `main` / `types` / `exports` / `engines` onto the compiled `dist/` at publish time. `files`
is `["dist", "scripts"]` and `prepublishOnly` runs the build.

`dist/` exists for the tarball and nothing else reads it. Emit and type-check run the same binary —
the stable native `tsc` ([ADR 0271](../../../.decisions/0271-one-compiler-effect-patched-tsc.md)) —
so the published artifact and the type gate cannot disagree about the compiler.
