# Calling an external CLI from Effect

Use this pattern for Node tooling that must read an external command's output,
such as Git or a validator. Cloudflare workers cannot spawn these processes.
Fabrika's GitHub requests use its HTTP client; they are not subprocess calls.

## Reuse the subprocess helpers

[`io/exec.ts`](../packages/fabrika-cli/src/io/exec.ts) owns subprocess execution.
It uses `ChildProcess` and `ChildProcessSpawner` from `effect/unstable/process`,
captures stdout, stderr and exit status concurrently, and scopes the handle's lifetime.
The owning package's Effect pin determines the available API; do not copy an older
`@effect/platform` `Command` example into this code.

Choose the helper by the answer the caller needs:

| Helper | Caller needs |
|---|---|
| `execCapture` | Text from a successful command, or a reason the read failed |
| `execCaptureInput` | The same answer, while supplying exact bytes on stdin |
| `execStatus` | A validator result that distinguishes `Ran` from `Unstartable` |
| `execRecord` | Captured bytes, timeout and truncation information under explicit limits |

`execCapture` returns `{ok, stdout, reason}` with `E = never`. A non-zero exit and
a spawn fault both produce `ok: false`. Read `ok` before interpreting stdout: an
empty failed read must not become a successful read that found nothing.

[`io/git.ts`](../packages/fabrika-cli/src/io/git.ts)'s `resolveCommit` is a small
consumer worth following. It runs `git rev-parse`, checks the command result, then
validates that the trimmed output is an object name. Exit zero alone cannot prove
the output has the shape the caller needs. For structured output, decode at this
boundary using the [schema guidance](./effect-schema-validation.md).

`execStatus` deliberately keeps a different distinction. A validator that ran and
reported defects is a negative result; a missing executable cannot establish one.
Callers must handle `Unstartable` separately. Captured validator diagnostics belong
on stderr, since the verb's stdout carries its own machine-readable answer.

The runner provides `NodeServices.layer` once in
[`run.ts`](../packages/fabrika-cli/src/run.ts). Use the existing helpers rather than
adding another process runner or providing the platform again inside a verb.

## GitHub calls use the shared HTTP client

[`io/gh-api.ts`](../packages/fabrika-cli/src/io/gh-api.ts) owns the transport used by
[`io/github.ts`](../packages/fabrika-cli/src/io/github.ts) and the other GitHub
adapters. Its responses retain HTTP status and pagination information, so adapters
do not recover those facts from command output. Follow the existing `authed` /
`onTransport` adapter shape and substitute `HttpClient` in tests.

[Skill conventions §11](../claude-plugins/fabrika/docs/skill-conventions.md#11-github-access-belongs-to-the-cli-transport)
owns the permitted API uses and guarded-verb boundary. The [CLI README](../packages/fabrika-cli/README.md)
owns credential setup; [ADR 0315 and its amendments](../.decisions/0315-fabrika-cli-github-token-resolution-and-the-three-non-rest-carves.md)
record the transport decision. Those rules are not a second subprocess recipe.

## Test the boundary the production code uses

For subprocess consumers, use `fakeShell` and `faultingShell` from
[`fakes.test-support.ts`](../packages/fabrika-cli/src/fakes.test-support.ts).
[`io/git.unit.test.ts`](../packages/fabrika-cli/src/io/git.unit.test.ts) covers
successful reads, bad output, non-zero exits and spawn failure without running Git.

For GitHub consumers, substitute `HttpClient` with `fakeHttp` from the same support
file. [`io/github.unit.test.ts`](../packages/fabrika-cli/src/io/github.unit.test.ts)
scripts responses and pagination. A subprocess double alone cannot test an HTTP
adapter's response handling.
