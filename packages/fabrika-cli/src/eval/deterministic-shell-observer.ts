/**
 * The deterministic tier's shell observer — the one IO leg of issue #4677.
 *
 * `deterministic-tier.ts` is pure and never spawns; this file is where a case's CLI-layer command
 * actually runs. It spawns a **process**, never a model — that separation is the point, and it is
 * why the two live in different files: the tier's purity is checkable by reading its imports.
 *
 * The subprocess and the artifact probes go through Effect's platform services, per
 * [.patterns/effect-process-cli-shell.md](../../../../.patterns/effect-process-cli-shell.md) and
 * [.patterns/effect-platform-access.md](../../../../.patterns/effect-platform-access.md), so a unit
 * test scripts the *services* rather than shelling for real.
 */
import {Duration, Effect, FileSystem, Path, Stream} from "effect";
import {ChildProcess, type ChildProcessSpawner} from "effect/unstable/process";
import type {
	CaseObserver,
	CliObservation,
	DeterministicCommand,
	TieredEvalCase,
} from "./deterministic-tier.ts";
import {namedArtifactPaths} from "./deterministic-tier.ts";

/** A CLI-layer eval case that outruns this is a case defect, not a slow machine. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/** Of the paths a case names, the ones present after the run. An unprobeable path counts as absent. */
const presentArtifacts = (
	evalCase: TieredEvalCase,
	cwd: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const present: Array<string> = [];
		for (const named of namedArtifactPaths(evalCase)) {
			const abs = path.isAbsolute(named) ? named : path.resolve(cwd, named);
			const exists = yield* fs.exists(abs).pipe(Effect.orElseSucceed(() => false));
			if (exists) present.push(named);
		}
		return present;
	});

/**
 * Run one case's command and report what it produced.
 *
 * The `notRun` / killed distinction is the §ZS rule in code. A command that never started (no
 * binary, a bad cwd) fails the *spawn* and yields `notRun`, which the tier reads as UNKNOWN — never
 * as "the assertion failed". A command that started and was then killed by the timeout reports
 * `exitStatus: null` with `notRun: null`: it *did* run and did not answer, which is a genuine
 * failure of the case.
 *
 * `toolInvocations` is `null` because a plain subprocess cannot see which tools a run used. That
 * is an honest "cannot observe", so a `tool-invocation` assertion reds as a case defect here
 * rather than silently failing — a transcript-backed observer (#4676) is what can answer it.
 */
export const observeShellCommand: CaseObserver<
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = (evalCase: TieredEvalCase, command: DeterministicCommand) =>
	Effect.gen(function* () {
		const cwd = command.cwd ?? process.cwd();
		const ran = yield* Effect.scoped(
			Effect.gen(function* () {
				const handle = yield* ChildProcess.make(command.command, [...command.args], {cwd});
				const [stdout, stderr, exitCode] = yield* Effect.all(
					[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
					{concurrency: "unbounded"},
				);
				// `ExitCode` is a branded number; `CliObservation`'s contract is the plain one.
				return {exitStatus: Number(exitCode), stdout, stderr};
			}),
		).pipe(
			Effect.timeoutOrElse({
				duration: Duration.millis(command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
				orElse: () => Effect.succeed({exitStatus: null, stdout: "", stderr: ""}),
			}),
			Effect.catchTag("PlatformError", (cause) => Effect.succeed({notRun: cause.message})),
		);

		if ("notRun" in ran) {
			return {
				exitStatus: null,
				stdout: "",
				stderr: "",
				artifacts: [],
				toolInvocations: null,
				notRun: ran.notRun,
			} satisfies CliObservation;
		}
		return {
			exitStatus: ran.exitStatus,
			stdout: ran.stdout,
			stderr: ran.stderr,
			artifacts: yield* presentArtifacts(evalCase, cwd),
			toolInvocations: null,
			notRun: null,
		} satisfies CliObservation;
	});
