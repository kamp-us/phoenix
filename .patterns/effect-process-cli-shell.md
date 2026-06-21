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

The canonical examples are `packages/pipeline-cli/src/tools/epic-ledger/github.ts`
(the richest: read + mutate, repo resolution, Schema-decoded JSON) and
`packages/pipeline-cli/src/tools/crabbox-manifest/commit.ts` (the smallest:
`git rev-parse HEAD` → one trimmed SHA). `packages/flake-rate/src/github.ts` is a
third, read-only, deliberately mirroring `epic-ledger`.

## When to use it

A package needs to run an external CLI whose output it has to read, and that CLI
isn't usefully reachable as a typed SDK — `gh api` (the GitHub REST surface; the
pipeline's only sanctioned GitHub access, since GraphQL is broken on the kamp-us
org) and `git` (for `rev-parse HEAD`). The shape is for **pipeline/tooling
packages run by the `pipeline-cli` bin on Node**, not the Cloudflare worker — the
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

In production the spawner comes from the Node platform: a tool bakes its live
layer in with `Command.provide(GithubLive)`
(`packages/pipeline-cli/src/tools/epic-ledger/command.ts`), and the bin provides
the platform union with `Effect.provide(NodeServices.layer)`
(`packages/pipeline-cli/src/bin.ts`) — `ChildProcessSpawner` is a `NodeServices`
member, so nothing in the tool ever names the platform.

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

- **Resolve ambient inputs (the repo) lazily and once.** Repo resolution
  (`CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` → `gh repo view`, ADR 0062 §1) is
  itself a `gh` call, so it's wrapped in `Effect.cached` and deferred to first
  method use — the layer build stays side-effect-free, `--help`/`--version` never
  shell out, and the result is memoized once per process. It never silently
  defaults to a repo: with nothing resolvable it fails `RepoResolutionError`, so a
  foreign install can't accidentally operate on phoenix.

## Testing — substitute the spawner

The `ChildProcessSpawner` seam is exactly what a `unit` test replaces
([effect-testing.md](./effect-testing.md)): no real `gh`/`git` runs. Provide a
fake spawner built with `ChildProcessSpawner.make` + `ChildProcessSpawner.makeHandle`
that answers with canned stdout/stderr/exit, or one that fails the spawn with a
`PlatformError` to exercise the not-on-`PATH` path. The canonical fakes are the
`cannedSpawner`/`faultingSpawner` and `mockSpawner` idioms in
`packages/pipeline-cli/src/tools/crabbox-manifest/commit.unit.test.ts` and
`packages/pipeline-cli/src/tools/epic-ledger/github-service.unit.test.ts`.

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
