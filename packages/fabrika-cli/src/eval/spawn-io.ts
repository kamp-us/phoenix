/**
 * The OS boundary for the eval runner: the one place in `eval` that starts a process (issue #4676,
 * ADR 0236). Every decision lives in `spawn.ts`; this file only performs.
 *
 * The platform is reached through Effect's services — `FileSystem` / `Path` and
 * `ChildProcess` / `ChildProcessSpawner` from `effect/unstable/process`, per
 * [.patterns/effect-platform-access.md](../../../../.patterns/effect-platform-access.md) and
 * [.patterns/effect-process-cli-shell.md](../../../../.patterns/effect-process-cli-shell.md). Every
 * fault stays a *value* the pure classifier in `spawn.ts` reads fail-closed (a `SpawnFailed` /
 * `TimedOut` result, a `null` transcript path), so the `E` channel is `never` throughout: lowering
 * these into typed errors would add a channel no caller can act on.
 *
 * A `claude -p` **subprocess is not a `Task` tool call**, so it is outside `spawn-guard`'s
 * `PreToolUse` surface entirely (measured, #4673 §5). That is what lets a run name any model — and
 * it is also why this must never be re-implemented as an in-session Task spawn, which would hard-deny
 * every model outside the guard's allowlist.
 */
import {homedir} from "node:os";
import {Duration, Effect, FileSystem, Option, Path, Stream} from "effect";
import {ChildProcess, type ChildProcessSpawner} from "effect/unstable/process";
import {buildClaudeArgs, type Executor, type ExecutorResult, type PlannedRun} from "./spawn.ts";

/**
 * Where `claude` keeps its per-session transcripts. `CLAUDE_CONFIG_DIR` overrides the default
 * per-user config dir (the 2.1.220 binary reads it in 27 places, #4673 §2).
 *
 * `homedir()` stays a raw `node:os` read taken at this boundary and threaded as a plain string:
 * Effect v4 ships no equivalent — there is no `Os` service and no `homeDir` on `FileSystem`/`Path`
 * — so this is the documented exemption in `.patterns/effect-platform-access.md`, "a node primitive
 * with no `@effect/platform` service", not a gap. It is a parameter default, so a test substitutes
 * it without a service; every path-keyed operation below goes through `Path`.
 */
export const claudeDataRoot = (
	env: Readonly<Record<string, string | undefined>> = process.env,
	home: string = homedir(),
): Effect.Effect<string, never, Path.Path> =>
	Effect.gen(function* () {
		const configured = env.CLAUDE_CONFIG_DIR;
		if (configured !== undefined && configured !== "") return configured;
		const path = yield* Path.Path;
		return path.join(home, ".claude");
	});

/**
 * Find a pinned session's transcript, or `null`.
 *
 * The file is `<data-root>/projects/<cwd-slug>/<session-id>.jsonl`, and the search is a scan of the
 * project dirs rather than a re-derivation of `<cwd-slug>` on purpose: the slug is a lossy
 * flattening of the working directory's separators, so re-deriving it breaks on any path the
 * flattening collapses, and would answer "no transcript" for a run that produced one (#4673 §7).
 */
export const locateTranscript = (
	sessionId: string,
	dataRoot?: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = dataRoot ?? (yield* claudeDataRoot());
		const dirs = yield* Effect.option(fs.readDirectory(path.join(root, "projects")));
		if (Option.isNone(dirs)) return null;
		const file = `${sessionId}.jsonl`;
		for (const dir of dirs.value) {
			const candidate = path.join(root, "projects", dir, file);
			if (Option.isSome(yield* Effect.option(fs.readFileString(candidate)))) return candidate;
		}
		return null;
	});

/** A transcript's raw text, or `null` when absent/unreadable — the `TranscriptLoader` `runner.ts` takes. */
export const readTranscript = (
	path: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.readFileString(path);
	}).pipe(Effect.orElseSucceed(() => null));

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/** The CLI version a scorecard is pinned to (#4680), or `null` when it cannot be read. */
export const claudeVersion = (
	executable = "claude",
): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(executable, ["--version"]);
			const [stdout, exitCode] = yield* Effect.all([collect(handle.stdout), handle.exitCode], {
				concurrency: "unbounded",
			});
			return exitCode === 0 ? stdout.trim() : null;
		}),
	).pipe(
		Effect.timeoutOrElse({duration: Duration.seconds(10), orElse: () => Effect.succeed(null)}),
		Effect.orElseSucceed(() => null),
	);

/**
 * The real executor: run one planned invocation to completion under a stated wall-clock bound.
 *
 * The three outcomes stay *values*, which is what keeps `classifyRun` total. `TimedOut` comes from
 * the timeout arm — the scope closes on interruption, so the child is reaped rather than orphaned —
 * and a spawn fault (an unresolvable executable) arrives as a `PlatformError` and folds into
 * `SpawnFailed`. So does a signal-killed child: `handle.exitCode` yields no number for one, it
 * fails with a `PlatformError` ("Process interrupted due to receipt of signal"), which the same
 * `catchTag` classifies `SpawnFailed` — the tag v1's explicit `status === null` branch produced.
 * Only a child that ran and reported an exit code is `Exited`, whatever that code is.
 */
export const claudeExecutor = (opts: {
	readonly timeoutMs: number;
	readonly cwd?: string;
	readonly executable?: string;
}): Executor<ChildProcessSpawner.ChildProcessSpawner> => {
	const executable = opts.executable ?? "claude";
	return (plan: PlannedRun) =>
		Effect.scoped(
			Effect.gen(function* () {
				const handle = yield* ChildProcess.make(
					executable,
					[...buildClaudeArgs(plan)],
					opts.cwd === undefined ? {} : {cwd: opts.cwd},
				);
				const [stdout, stderr, exitCode] = yield* Effect.all(
					[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
					{concurrency: "unbounded"},
				);
				// `ExitCode` is a branded number; the classifier's contract is the plain one.
				return {_tag: "Exited", code: Number(exitCode), stdout, stderr} satisfies ExecutorResult;
			}),
		).pipe(
			Effect.timeoutOrElse({
				duration: Duration.millis(opts.timeoutMs),
				orElse: (): Effect.Effect<ExecutorResult> =>
					Effect.succeed({_tag: "TimedOut", boundMs: opts.timeoutMs}),
			}),
			Effect.catchTag(
				"PlatformError",
				(cause): Effect.Effect<ExecutorResult> =>
					Effect.succeed({_tag: "SpawnFailed", detail: cause.message}),
			),
		);
};
