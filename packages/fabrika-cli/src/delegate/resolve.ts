/**
 * Decide, and then act on, which copy of `fabrika-cli` serves this invocation.
 *
 * The decision is a pure function of four facts — where the running copy lives, whether there is a
 * repo root, what the root's install probe said, and what the root manifest declares — so every
 * branch is testable without a filesystem.
 *
 * **Every branch ends in a working CLI, and only one of them is silent.** No repo root at all runs
 * the global with no warning, deliberately, so global-only invocations still work. A repo root whose
 * local install is missing or corrupt runs the global too, but *says so loudly* — that pairing is
 * the whole design: tiers that can only be right or loudly absent are fine; tiers that can be
 * quietly wrong are the defect (#4784).
 */
import {Effect} from "effect";
import {ChildProcess, type ChildProcessSpawner} from "effect/unstable/process";
import type {LocalInstall, LocalProbe} from "./local.ts";

/**
 * The child's recursion guard, passed as a **flag** rather than an environment variable so it is
 * visible in a process list. `FABRIKA_SKIP_INFER` is the same guard for a caller who cannot alter
 * argv. Both are read before any filesystem work happens.
 */
export const SKIP_INFER_FLAG = "--skip-infer";
export const SKIP_INFER_ENV = "FABRIKA_SKIP_INFER";

/** The user's original cwd, handed to the child because the child's own cwd is the repo root. */
export const INVOCATION_DIR_ENV = "FABRIKA_INVOCATION_DIR";

/** Set to any value to silence the no-local-install warning. */
export const GLOBAL_WARNING_DISABLED_ENV = "FABRIKA_GLOBAL_WARNING_DISABLED";

export const DEBUG_ENV = "FABRIKA_CLI_DEBUG";

export type Resolution =
	| {readonly _tag: "run-here"; readonly why: string}
	| {readonly _tag: "delegate"; readonly to: LocalInstall}
	| {
			readonly _tag: "warn-and-run-here";
			readonly repoRoot: string;
			readonly reason: string;
	  };

export interface ResolveInput {
	/** The real path of the package root the running bin belongs to. */
	readonly selfPackageRoot: string;
	/** `undefined` when the cwd is in no repo at all — the one silent branch. */
	readonly repoRoot: string | undefined;
	readonly local: LocalProbe | undefined;
}

/** Which copy serves this invocation. Total over the four states; there is no fallthrough. */
export const resolve = ({selfPackageRoot, repoRoot, local}: ResolveInput): Resolution => {
	if (repoRoot === undefined) return {_tag: "run-here", why: "the cwd is not inside a repo"};
	if (local === undefined || local._tag === "absent")
		return {_tag: "warn-and-run-here", repoRoot, reason: "it has no local install"};
	if (local._tag === "corrupt") return {_tag: "warn-and-run-here", repoRoot, reason: local.reason};
	if (local.install.packageRoot === selfPackageRoot)
		return {_tag: "run-here", why: "the repo-local install is this copy"};
	return {_tag: "delegate", to: local.install};
};

export interface WarningInput {
	readonly repoRoot: string;
	readonly reason: string;
	readonly globalVersion: string;
	readonly declared: string | undefined;
}

/**
 * The loud branch's text: which repo, why the local was unusable, and **both** versions in play.
 *
 * Naming the declared version beside the global's is what makes the warning actionable rather than
 * noise — it is the difference between "something is off" and "this repo wanted 0.4.0 and you are
 * running 0.1.0, run an install".
 */
export const globalWarning = ({repoRoot, reason, globalVersion, declared}: WarningInput): string =>
	[
		`fabrika-cli: running the GLOBAL install (v${globalVersion}) — ${repoRoot} ${reason}.`,
		declared === undefined
			? `  ${repoRoot}/package.json declares no @kampus/fabrika-cli dependency.`
			: `  ${repoRoot}/package.json declares @kampus/fabrika-cli ${declared}; install it to run the version this repo pins.`,
		`  Silence this with ${GLOBAL_WARNING_DISABLED_ENV}=1.`,
	].join("\n");

/**
 * One stderr line naming which copy serves this invocation and where it lives.
 *
 * Emitted only under {@link DEBUG_ENV}. Without a trace the delegation is unobservable from the
 * outside — the two copies print identical bytes, which is the point of the design and also what
 * makes "did it delegate?" unanswerable. turbo's shim solves it the same way.
 */
export const traceLine = (selfPackageRoot: string, resolution: Resolution): string => {
	switch (resolution._tag) {
		case "delegate":
			return `fabrika-cli: global at ${selfPackageRoot} — delegating to the repo-local install at ${resolution.to.packageRoot} (${resolution.to.binPath}, v${resolution.to.version})`;
		case "warn-and-run-here":
			return `fabrika-cli: running here, at ${selfPackageRoot} — repo root ${resolution.repoRoot}, but ${resolution.reason}`;
		case "run-here":
			return `fabrika-cli: running here, at ${selfPackageRoot} — ${resolution.why}`;
	}
};

/** How the child ended: its own status, or the signal that killed it. */
export type ChildOutcome =
	| {readonly _tag: "exited"; readonly status: number}
	| {readonly _tag: "signalled"; readonly signal: NodeJS.Signals};

export interface SpawnInput {
	readonly execPath: string;
	readonly binPath: string;
	/** The verb and its flags — this process's argv with the node binary and the bin stripped. */
	readonly args: ReadonlyArray<string>;
	/** The **repo root**, not the user's cwd; the user's cwd travels in {@link INVOCATION_DIR_ENV}. */
	readonly cwd: string;
	readonly invocationDir: string;
}

/**
 * effect v4's `ChildProcessHandle` exposes only an `ExitCode`; a child killed by a signal surfaces
 * as a `PlatformError` whose message names the signal, and there is no structured field for it
 * (`@effect/platform-node-shared` `NodeChildProcessSpawner`, the `exitCode` deferred). Recovering
 * the name from the message is therefore the only way to re-raise the signal on ourselves, and a
 * message that stops matching must read as "could not tell", never as a clean exit.
 */
const SIGNAL_MESSAGE = /receipt of signal: '([A-Z0-9]+)'/;

export const signalFromError = (message: string): NodeJS.Signals | undefined => {
	const matched = SIGNAL_MESSAGE.exec(message);
	return matched === null ? undefined : (matched[1] as NodeJS.Signals);
};

/**
 * Run the repo-local bin as a child and report how it ended.
 *
 * Stdio is inherited on all three descriptors, so the delegation is invisible to a caller: a verb
 * reading stdin still reads the real fd 0, and its stdout is the same bytes at the same fd. That is
 * what keeps the CLI's own IO contract intact across the hop.
 *
 * Node is spawned explicitly with the bin path rather than the bin being executed: on Windows a JS
 * bin is not directly executable, and this sidesteps the `.cmd` shim entirely.
 */
export const spawnDelegate = ({
	execPath,
	binPath,
	args,
	cwd,
	invocationDir,
}: SpawnInput): Effect.Effect<ChildOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(execPath, [binPath, SKIP_INFER_FLAG, ...args], {
				cwd,
				env: {[INVOCATION_DIR_ENV]: invocationDir},
				extendEnv: true,
				detached: false,
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
			const outcome: ChildOutcome = {_tag: "exited", status: Number(yield* handle.exitCode)};
			return outcome;
		}),
	).pipe(
		Effect.catchTag("PlatformError", (cause): Effect.Effect<ChildOutcome> => {
			const signal = signalFromError(cause.message);
			if (signal !== undefined) return Effect.succeed({_tag: "signalled", signal});
			// A spawn that never happened must not read as the child's own verdict. `2` is this
			// package's reserved "could not resolve an implementation" code, distinct from `1` (a
			// verb's usage error) and from `127` (nothing ran at all) — see the convention doc's
			// rule 3 table.
			return Effect.sync(() => {
				console.error(
					`fabrika-cli: found a repo-local install but could not run it.\n` +
						`  tried: ${execPath} ${binPath}\n` +
						`  cause: ${cause.message}`,
				);
				return {_tag: "exited", status: 2};
			});
		}),
	);
