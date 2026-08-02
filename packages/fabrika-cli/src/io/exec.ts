/**
 * The one subprocess seam — `git` and `gh` spawned through `ChildProcess` / `ChildProcessSpawner`
 * from `effect/unstable/process`, per
 * [.patterns/effect-process-cli-shell.md](../../../../.patterns/effect-process-cli-shell.md). The
 * platform spawner is the substitutable seam, so a unit test scripts the *service* rather than a
 * hand-rolled function double, and `run.ts`'s `NodeServices.layer` is what satisfies it in the bin.
 *
 * Every caller reads `ok` before `stdout`. That is the whole discipline this file exists to make
 * unavoidable: a failed invocation returns empty `stdout`, and empty `stdout` is byte-identical to
 * a successful invocation that found nothing. Interpreting bytes without first reading the status
 * is how a check comes to answer a plausible value instead of an error.
 *
 * A non-zero exit is **data**, not a failure on the `E` channel — `git rev-parse` on a ref that does
 * not resolve is an outcome this package turns into a specific exit code, not an exception. A spawn
 * fault (`gh` absent from `PATH`) arrives as a `PlatformError` and folds into the same record, so
 * `E` is `never` and the status lives in `ok`.
 */
import {Effect, Stream} from "effect";
import {ChildProcess, type ChildProcessSpawner} from "effect/unstable/process";

export interface ExecResult {
	readonly ok: boolean;
	readonly stdout: string;
	/** The first line of stderr, or the spawn fault's message — enough to quote in a refusal. */
	readonly reason: string;
}

/** A captured run of one command. The spawner is the requirement; no caller passes an injectable. */
export type Exec = Effect.Effect<ExecResult, never, ChildProcessSpawner.ChildProcessSpawner>;

const firstLine = (s: string): string => (s.split("\n").find((l) => l.trim() !== "") ?? "").trim();

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/** Run a command, capturing stdout; a non-zero exit and a spawn fault are both data, never a throw. */
export const execCapture = (file: string, args: ReadonlyArray<string>): Exec =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(file, [...args]);
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
				{concurrency: "unbounded"},
			);
			if (exitCode !== 0) {
				return {
					ok: false,
					stdout: "",
					reason: firstLine(stderr) || `${file} exited ${exitCode}`,
				};
			}
			return {ok: true, stdout, reason: ""};
		}),
	).pipe(
		Effect.catchTag("PlatformError", (cause) =>
			Effect.succeed({
				ok: false,
				stdout: "",
				reason: firstLine(cause.message) || `could not run ${file}`,
			}),
		),
	);
