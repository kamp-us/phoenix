# @kampus/tuval-agy

Tuval's agy harness: the `agy-session` program row, the launch preflight in front of it, the adapter
that drives the `agy` CLI over a subprocess pipe (`AgyAiAgent`), the history reader over agy's own
transcript logs, and the agy chat window.

It is an official plugin package, built on `@kampus/tuval-sdk` and `@kampus/tuval-ui` through their
exports maps the same way an outside program is. The desk app registers agy by importing it. The
supported floor and the sandbox posture are in
[ADR 0362](../../.decisions/0362-agy-sandbox-scoped-auto-approval.md).

## Usage

A config registers the row:

```ts
// <project>/.tuval/tuval.config.ts
import {agySessionProgram} from "@kampus/tuval-agy";
import type {TuvalConfigInput} from "@kampus/tuval-sdk/kernel/config";

export default {
  version: 1,
  programs: [agySessionProgram({cwd: "/path/to/repo", agy: {model: "gemini-3.1-pro-high"}})],
} satisfies TuvalConfigInput;
```

A page's renderer table takes the window from `@kampus/tuval-agy/window`, which reaches React and
nothing of agy's subprocess.

The row needs `agy` on `PATH` at or above the version floor, and a
`~/.gemini/antigravity-cli/settings.json` carrying `toolPermission: "proceed-in-sandbox"` and a
`write_file` rule under `permissions.allow`. The preflight checks both before a session opens and
refuses with the fix named. Building the row starts nothing.

## Dependencies

`@kampus/tuval-sdk`, `effect` and `react` are peer dependencies: the desk supplies the one copy of
each. `@kampus/tuval-ui`, `@kampus/design` and `@effect/platform-node` are regular dependencies.
agy itself is the operator's own binary, not an npm package.

The package is workspace-only for now. It ships TypeScript source, and the window imports a
stylesheet, so a consumer bundles it with Vite, as the desk does.
