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
import {Duration, Effect, Stream} from "effect";
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

/**
 * What one **recorded** run of an arbitrary command produced — a second reading of this seam, for a
 * caller that must tell "ran and answered no" from "could not run".
 *
 * `execCapture` above fuses those two: a non-zero exit and a spawn fault both arrive as `ok: false`,
 * which is right for `git`/`gh` (a failed read is a failed read) and wrong for a prototype, where
 * the command's own status **is** the observation. So the three outcomes are separate constructors
 * here and the caller cannot collapse them by accident.
 */
export type ChildOutcome =
	| {
			readonly _tag: "Ran";
			/** The child's own status, or `null` when it was killed at the timeout. */
			readonly exitCode: number | null;
			readonly timedOut: boolean;
			readonly stdout: Uint8Array;
			readonly stderr: Uint8Array;
			/** Either stream reached the capture bound and the remainder was discarded. */
			readonly truncated: boolean;
	  }
	| {readonly _tag: "Unstartable"; readonly reason: string};

export interface ChildRequest {
	readonly file: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
	/** The child's whole environment. Nothing is inherited: what is not here does not reach it. */
	readonly env: Readonly<Record<string, string>>;
	readonly timeoutSeconds: number;
	/** Bytes captured per stream before capture stops and `truncated` is set. */
	readonly captureBytes: number;
}

/** The seam a recording caller injects, so a timeout and an unstartable binary are both testable. */
export type ChildRunner = (
	request: ChildRequest,
) => Effect.Effect<ChildOutcome, never, ChildProcessSpawner.ChildProcessSpawner>;

const captureBounded = (
	stream: Stream.Stream<Uint8Array, unknown>,
	bound: number,
): Effect.Effect<{readonly bytes: Uint8Array; readonly truncated: boolean}> =>
	Effect.gen(function* () {
		const parts: Uint8Array[] = [];
		let total = 0;
		let truncated = false;
		yield* Stream.runForEach(stream, (chunk) =>
			Effect.sync(() => {
				const room = bound - total;
				if (room <= 0) {
					truncated = chunk.length > 0 || truncated;
					return;
				}
				if (chunk.length > room) {
					parts.push(chunk.subarray(0, room));
					total = bound;
					truncated = true;
					return;
				}
				parts.push(chunk);
				total += chunk.length;
			}),
		).pipe(Effect.orElseSucceed(() => undefined));
		const bytes = new Uint8Array(total);
		let at = 0;
		for (const part of parts) {
			bytes.set(part, at);
			at += part.length;
		}
		return {bytes, truncated};
	});

/**
 * Execute one command in `cwd` under exactly `env`, capturing both streams to a byte bound.
 *
 * `detached: true` puts the child in its own process group, which is what makes the timeout able to
 * take its descendants with it: a prototype that spawns a dev server and hangs leaves the server
 * running if only the direct child is signalled. The group kill is attempted first and the handle's
 * own kill is the fallback, because a spawner that did not honour `detached` still has a child to
 * signal.
 */
export const execRecord: ChildRunner = (request) =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(request.file, [...request.args], {
				cwd: request.cwd,
				env: {...request.env},
				extendEnv: false,
				detached: true,
			});
			const killGroup: Effect.Effect<void> = Effect.try({
				try: () => globalThis.process.kill(-handle.pid, "SIGKILL"),
				catch: () => "the process group could not be signalled" as const,
			}).pipe(
				Effect.catchCause(() =>
					handle.kill({killSignal: "SIGKILL"}).pipe(Effect.orElseSucceed(() => undefined)),
				),
				Effect.asVoid,
			);
			const streams = Effect.all(
				[
					captureBounded(handle.stdout, request.captureBytes),
					captureBounded(handle.stderr, request.captureBytes),
				],
				{concurrency: "unbounded"},
			);
			const exit = handle.exitCode.pipe(
				Effect.map((code): number | null => code),
				Effect.orElseSucceed((): number | null => null),
				Effect.timeoutOption(Duration.seconds(request.timeoutSeconds)),
			);
			const [captured, status] = yield* Effect.all([streams, exit], {concurrency: "unbounded"});
			const [out, err] = captured;
			if (status._tag === "None") {
				yield* killGroup;
				return {
					_tag: "Ran" as const,
					exitCode: null,
					timedOut: true,
					stdout: out.bytes,
					stderr: err.bytes,
					truncated: out.truncated || err.truncated,
				};
			}
			return {
				_tag: "Ran" as const,
				exitCode: status.value,
				timedOut: false,
				stdout: out.bytes,
				stderr: err.bytes,
				truncated: out.truncated || err.truncated,
			};
		}),
	).pipe(
		Effect.catchTag("PlatformError", (cause) =>
			Effect.succeed({
				_tag: "Unstartable" as const,
				reason: firstLine(cause.message) || `could not run ${request.file}`,
			}),
		),
	);

const captured = (file: string, args: ReadonlyArray<string>, input: string | null): Exec =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle =
				input === null
					? yield* ChildProcess.make(file, [...args])
					: yield* ChildProcess.make(file, [...args], {
							stdin: Stream.fromIterable([new TextEncoder().encode(input)]),
						});
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

/** Run a command, capturing stdout; a non-zero exit and a spawn fault are both data, never a throw. */
export const execCapture = (file: string, args: ReadonlyArray<string>): Exec =>
	captured(file, args, null);

/**
 * A validator's run, with "it is not installed" kept apart from "it ran and found defects".
 *
 * {@link execCapture} fuses the two into `ok: false`, which is right for `git`/`gh` — a failed read
 * is a failed read — and wrong for a validator, where the two answers have opposite polarity: a
 * non-zero exit is a proven red, and an absent binary proves nothing and must refuse UNKNOWN.
 *
 * The split is the spawner's, not a guess off the message: `NodeChildProcessSpawner` resumes the
 * spawn with a `PlatformError` from the child's `error` event, which is where Node reports `ENOENT`
 * for a binary that is not on `PATH`; a child that starts and exits non-zero never reaches it.
 */
export type ExecStatus =
	/** `output` is the child's diagnostics — stderr when it wrote any, else stdout. */
	| {readonly _tag: "Ran"; readonly ok: boolean; readonly output: string}
	| {readonly _tag: "Unstartable"; readonly reason: string};

/**
 * Run a validator for its status and its diagnostics.
 *
 * Both streams are captured rather than inherited, and stdout deliberately does not pass through:
 * this package's stdout is its machine channel, and a linter that writes its findings there —
 * `actionlint` does — would fuse its output with the verb's own answer. The caller re-emits what it
 * captured on stderr, where a refusal's notes already go.
 */
export const execStatus = (
	file: string,
	args: ReadonlyArray<string>,
	/** Where to run it; omitted, the child inherits this process's directory. */
	cwd?: string,
): Effect.Effect<ExecStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle =
				cwd === undefined
					? yield* ChildProcess.make(file, [...args])
					: yield* ChildProcess.make(file, [...args], {cwd});
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
				{concurrency: "unbounded"},
			);
			const output = stderr.trim() === "" ? stdout : stderr;
			return {
				_tag: "Ran" as const,
				ok: exitCode === 0,
				output: output.trim() === "" ? `${file} exited ${exitCode}` : output,
			};
		}),
	).pipe(
		Effect.catchTag("PlatformError", (cause) =>
			Effect.succeed<ExecStatus>({
				_tag: "Unstartable",
				reason: firstLine(cause.message) || `could not run ${file}`,
			}),
		),
	);

/**
 * The same run with `input` piped to the child's stdin — the file-free carrying path.
 *
 * It exists so a message can reach a command **without a file on disk at all** (§SP rule 1). The
 * scar is `git commit -F <path>`: the path is a second place the bytes live, and a lane that read
 * back a two-day-old file at that path committed another lane's message with nothing failing
 * anywhere (#5484). Bytes handed straight to the child cannot be stale.
 */
export const execCaptureInput = (file: string, args: ReadonlyArray<string>, input: string): Exec =>
	captured(file, args, input);
