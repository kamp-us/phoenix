# Tuval

Tuval is a local app. Its interface copy is English. It shares no worker or fate
data layer with `apps/web`.

Keep backend sessions and subscriptions owned by their process/session scope.
Browser code must remain free of Node imports; the browser TypeScript project
checks that separation. Rendered UI follows the root design manifest.

Use this app's Vitest projects. Its `integration` tier exercises real local sessions
and sockets, not remote D1. Proofs using a real provider are different from scripted
proofs; read the selected proof's contract before running it.

The [README](README.md) owns local setup. Use the shared
[pattern index](../../.patterns/index.md) for the relevant kernel, backend, layout
or test guidance.
