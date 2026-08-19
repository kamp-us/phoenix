# Shelling a CLI over `effect/unstable/process`

How a phoenix package shells out to an external CLI — `gh`, `git` — as an Effect
service. This is the pipeline tooling's IO shell over a subprocess: spawn the
command, capture stdout/stderr/exit, and lower every fault into a typed error in
the `E` channel. It's the `effect/unstable/process` counterpart of the
trust-boundary work in [effect-schema-validation.md](./effect-schema-validation.md)
— the spawn shell is where untyped CLI output enters, and Schema decodes it the
moment it does.

> [!IMPORTANT]
> **phoenix is on Effect v4** — the subprocess primitives are `ChildProcess` and
> `ChildProcessSpawner` from **`effect/unstable/process`**, not `@effect/platform`'s
> `Command`/`CommandExecutor`. The v3 `Command.make(...).pipe(Command.string)` idiom
> most training data shows does not apply here.

The canonical example is [`packages/fabrika-cli/src/io/exec.ts`](../packages/fabrika-cli/src/io/exec.ts)
— the one subprocess seam: spawn, read all three channels, fold a spawn fault into the result. Its
two readers are [`packages/fabrika-cli/src/io/git.ts`](../packages/fabrika-cli/src/io/git.ts) (`git`
refs and remotes) and [`packages/fabrika-cli/src/io/github.ts`](../packages/fabrika-cli/src/io/github.ts)
(`gh api` REST, paged, shape-validated).

## When to use it

A package needs to run an external CLI whose output it has to read, and that CLI
isn't usefully reachable as a typed SDK — `gh api` (the GitHub REST surface; the
pipeline's only sanctioned GitHub access, since GraphQL is broken on the kamp-us
org) and `git` (for `rev-parse HEAD`). The shape is for **pipeline/tooling
packages run by the `fabrika` bin on Node**, not the Cloudflare worker — the
worker has no subprocess to spawn.

If you only need the CLI's exit status to gate a build step and don't read its
output as data, the same `ChildProcess.make` + `exitCode` half still applies; you
just skip the decode.

## The canonical shape

The capability is a `Context.Service`
([effect-context-service.md](./effect-context-service.md)) whose live layer's
requirement (`R`) is `ChildProcessSpawner`, captured once at construction and
provided *into* each method body — so the service's public methods carry
`R = never`. The spawner is the layer's dependency, not the caller's.

### 1. Spawn the handle, read all three channels at once

`ChildProcess.make(command, args)` yields a scoped handle. Read `stdout`,
`stderr`, and `exitCode` concurrently, then branch on the exit code:

```ts
import {Effect, Stream} from "effect";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

const runGh = Effect.fn("Github.runGh")(
	function* (args: ReadonlyArray<string>) {
		const handle = yield* ChildProcess.make("gh", args);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
			{concurrency: "unbounded"},
		);
		if (exitCode !== 0) {
			return yield* new GhCommandError({args, exitCode, stderr});
		}
		return stdout;
	},
	Effect.scoped,
	(effect, args) =>
		Effect.catchTag(
			effect,
			"PlatformError",
			(cause) => new GhCommandError({args, exitCode: -1, stderr: cause.message}),
		),
);
```

### 2. Decode the output at the boundary

stdout is untyped text. JSON output is `JSON.parse`'d inside an `Effect.try` (a
malformed parse is a typed `GhParseError`), then handed to a `Schema`
trust-boundary decode that keeps only the fields the domain needs and rejects a
structurally-invalid shape as `SchemaError`
([effect-schema-validation.md](./effect-schema-validation.md)). Decoding happens
here, at the shell — nothing downstream carries raw CLI text.

### 3. Wire the layer — spawner captured once, repo resolved lazily

```ts
export const GithubLive: Layer.Layer<Github, never, ChildProcessSpawner.ChildProcessSpawner> =
	Layer.effect(Github)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const withSpawner = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
			const repo = yield* Effect.cached(withSpawner(resolveRepo()));
			return {
				epicLedger: (n: number) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(loadEpicLedger(r, n)))),
				// …
			};
		}),
	);
```

In production the spawner comes from the Node platform: the runner provides the
platform union once with `Effect.provide(NodeServices.layer)`
(`packages/fabrika-cli/src/run.ts`, entered from `packages/fabrika-cli/src/bin.ts`)
— `ChildProcessSpawner` is a `NodeServices` member, so nothing in a verb ever names
the platform.

## Gotchas the real usages reveal

- **`ChildProcessSpawner.string` hides the exit code — spawn the handle directly.**
  The convenience helper surfaces only spawn/IO faults, not the process's *own*
  non-zero exit; it would return partial stdout as if a failed `gh` call had
  succeeded. To gate on the exit code you must spawn the handle and read
  `handle.exitCode` yourself. This is why `runGh` builds the handle by hand
  rather than calling `.string`.

- **A spawn fault is a `PlatformError` — fold it into the same typed error.**
  `gh`/`git` not on `PATH` (`spawn ENOENT`) fails the *running* of the command,
  distinct from a non-zero exit, and arrives as effect's `PlatformError`. Catch it
  with `Effect.catchTag("PlatformError", …)` and lower it into the same domain
  error (the usages use exit code `-1` as the sentinel) so the `E` channel carries
  only the package's own typed errors, never a raw platform fault.

- **`Effect.scoped` closes the handle.** `ChildProcess.make` is scoped; the method
  must run under `Effect.scoped` (passed as an `Effect.fn` wrapper above) so the
  child process is reaped when the effect completes.

- **An empty/blank result can be a hard error, not an empty success.** `git
  rev-parse HEAD` exiting 0 with blank stdout is still a failure when the SHA is a
  binding key — `commit.ts` raises `MissingCommitError` on a blank trimmed result
  (ADR 0054 §1). Trim and check; don't pass an empty string downstream as if it
  were data.

- **A non-zero exit can be data, not a failure.** `exec.ts` returns
  `{ok, stdout, reason}` with `E = never` and folds the `PlatformError` in too, so a
  spawn fault and a non-zero exit arrive on the same channel; callers read `ok`
  before `stdout`, because empty `stdout` from a failed call is byte-identical to a
  successful call that found nothing. Raise a typed error only where the caller
  cannot express the failure as an outcome — the typed-error snippets above
  illustrate that variant, not the default.

- **Resolve ambient inputs (the repo) lazily and once.** The repo slug is parsed
  off the checkout's own remotes (`parseOwnerRepo` / `remoteFor` in
  [`packages/fabrika-cli/src/io/git.ts`](../packages/fabrika-cli/src/io/git.ts)),
  which is itself a `git` call — so resolve it at first use rather than at layer
  build, keep `--help`/`--version` from shelling out, and never silently default to
  a repo, so a foreign install can't accidentally operate on phoenix.

## Testing — substitute the spawner

The `ChildProcessSpawner` seam is exactly what a `unit` test replaces
([effect-testing.md](./effect-testing.md)): no real `gh`/`git` runs. Provide a
fake spawner built with `ChildProcessSpawner.make` + `ChildProcessSpawner.makeHandle`
that answers with canned stdout/stderr/exit, or one that fails the spawn with a
`PlatformError` to exercise the not-on-`PATH` path. The canonical fakes are the
`shell`/`faultingShell` canned-spawner idioms in
[`packages/fabrika-cli/src/fakes.test-support.ts`](../packages/fabrika-cli/src/fakes.test-support.ts),
used by `packages/fabrika-cli/src/io/git.unit.test.ts` and
`packages/fabrika-cli/src/io/github.unit.test.ts`.

```ts
const cannedSpawner = (canned: Canned): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* () {
				return ChildProcessSpawner.makeHandle({
					stdout: Stream.fromIterable([enc.encode(canned.stdout)]),
					stderr: Stream.fromIterable([enc.encode(canned.stderr ?? "")]),
					exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(canned.exitCode ?? 0)),
					// …the rest of the handle: stdin: Sink.drain, kill, unref, …
				});
			}),
		),
	);
```

## See also

- [effect-context-service.md](./effect-context-service.md) — the `Context.Service` + layer shape this IO shell is built on
- [effect-schema-validation.md](./effect-schema-validation.md) — decoding the CLI's untyped output at the trust boundary
- [effect-errors.md](./effect-errors.md) — the tagged errors (`GhCommandError`/`GhParseError`/`MissingCommitError`) the faults lower into
- [effect-error-operators.md](./effect-error-operators.md) — `Effect.catchTag` for folding the `PlatformError` spawn fault
- [effect-testing.md](./effect-testing.md) — the `unit` tier and the spawner-substitution test seam
