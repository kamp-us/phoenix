# Tuval

Tuval is a local app. Its interface copy is English. It shares no worker or fate
data layer with `apps/web`.

This app is `@kampus-apps/tuval`, and nothing imports it
([ADR 0407](../../.decisions/0407-apps-are-never-imported.md)). The kernel and the
program-author API live in the Tuval SDK, [`packages/tuval`](../../packages/tuval)
(`@kampus/tuval-sdk`). The chat UI lives in [`packages/tuval-ui`](../../packages/tuval-ui),
and each AI harness has its own `packages/tuval-<harness>`. Use them only through their
published exports, never by relative path. Code another package needs moves into a package; it
never gets an export here.

Keep backend sessions and subscriptions owned by their process/session scope.
Browser code must remain free of Node imports; the browser TypeScript project
checks that separation. Rendered UI follows the root design manifest.

Use this app's Vitest projects. Its `integration` tier exercises real local sessions
and sockets, not remote D1. Proofs using a real provider are different from scripted
proofs; read the selected proof's contract before running it.

A hand-verification desk — the scratch instance a builder drives by hand, since this app deploys to
no preview and a reviewer has no address to render
([ADR 0391](../../.decisions/0391-hand-verification-binds-ui-content.md)) — lives entirely under the
path `fabrika build scratch <n> --slug desk --token <t>` prints: the project directory the desk
opens, the scratch agent home it runs under — which is where its checkpoints land, under that
home's `.tuval/projects/<key>`
([ADR 0402](../../.decisions/0402-tuval-state-lives-under-home.md)) — and its driver scripts. Never
a directory you name yourself in the session scratchpad, which every lane of the
session shares
([build](../../claude-plugins/fabrika/skills/build/SKILL.md),
[build-ui](../../claude-plugins/fabrika/skills/build-ui/SKILL.md)).

The [README](README.md) owns local setup. Use the shared
[pattern index](../../.patterns/index.md) for the relevant kernel, backend, layout
or test guidance.
