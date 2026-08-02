/**
 * The deterministic tier's shell observer — the one IO leg of issue #4677.
 *
 * `deterministic-tier.ts` is pure and never spawns; this file is where a case's CLI-layer command
 * actually runs. It spawns a **process**, never a model — that separation is the point, and it is
 * why the two live in different files: the tier's purity is checkable by reading its imports.
 *
 * Sync `spawnSync` matches this package's existing subprocess idiom (`main-sync`, `verified-push`)
 * and keeps the observer a plain function the pure core can call.
 */
import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {isAbsolute, resolve} from "node:path";
import type {
	CaseObserver,
	CliObservation,
	DeterministicCommand,
	TieredEvalCase,
} from "./deterministic-tier.ts";
import {namedArtifactPaths} from "./deterministic-tier.ts";

/** A CLI-layer eval case that outruns this is a case defect, not a slow machine. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** Well above the 1 MB default: exceeding `maxBuffer` kills the child and forges a failure. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Run one case's command and report what it produced.
 *
 * The `notRun` / killed distinction is the §ZS rule in code. A command that never started (no
 * binary, a bad cwd) yields `notRun`, which the tier reads as UNKNOWN — never as "the assertion
 * failed". A command that started and was then killed (timeout, signal) reports `exitStatus: null`
 * with `notRun: null`: it *did* run and did not answer, which is a genuine failure of the case.
 *
 * `toolInvocations` is `null` because a plain subprocess cannot see which tools a run used. That
 * is an honest "cannot observe", so a `tool-invocation` assertion reds as a case defect here
 * rather than silently failing — a transcript-backed observer (#4676) is what can answer it.
 */
export const observeShellCommand: CaseObserver = (
	evalCase: TieredEvalCase,
	command: DeterministicCommand,
): CliObservation => {
	const cwd = command.cwd ?? process.cwd();
	const run = spawnSync(command.command, [...command.args], {
		cwd,
		encoding: "utf8",
		timeout: command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
		maxBuffer: MAX_OUTPUT_BYTES,
	});

	// `error` with no signal means the child never started at all — ENOENT, EACCES, a bad cwd.
	// A timeout also sets `error`, but with a signal, and that child DID run.
	if (run.error !== undefined && run.signal === null) {
		return {
			exitStatus: null,
			stdout: "",
			stderr: "",
			artifacts: [],
			toolInvocations: null,
			notRun: run.error.message,
		};
	}

	return {
		exitStatus: run.status,
		stdout: run.stdout ?? "",
		stderr: run.stderr ?? "",
		artifacts: namedArtifactPaths(evalCase).filter((path) =>
			existsSync(isAbsolute(path) ? path : resolve(cwd, path)),
		),
		toolInvocations: null,
		notRun: null,
	};
};
