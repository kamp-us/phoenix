/**
 * Decide, and then act on, which copy of `fabrika-cli` serves this invocation.
 *
 * The decision is a pure function of two facts — where the running copy lives, and what the walk
 * found — so every branch is testable without a filesystem. The acting half spawns the repo-local
 * bin with this process's own argv and hands back its exit code unchanged.
 *
 * **Both branches end in a working CLI.** A repo-local install is a real installed package; the
 * global is a real installed package. Neither is selected by guessing whether a file happens to be
 * runnable, which is the tier shape #4784 rejected.
 */
import {Effect} from "effect";
import {ChildProcess, type ChildProcessSpawner} from "effect/unstable/process";
import type {LocalInstall} from "./discover.ts";

/**
 * Set on the child, never read from a user's environment. It is a cycle breaker, not a locator:
 * unset means "resolve normally", which is what every real caller passes.
 */
export const DELEGATED_ENV = "FABRIKA_CLI_DELEGATED";

export type Resolution =
	| {readonly _tag: "run-here"; readonly why: string}
	| {readonly _tag: "delegate"; readonly to: LocalInstall};

export interface ResolveInput {
	/** The real path of the package root the running bin belongs to. */
	readonly selfPackageRoot: string;
	readonly found: LocalInstall | undefined;
	/** Whether this process is already the product of a delegation. */
	readonly alreadyDelegated: boolean;
}

/** Which copy serves this invocation. Total over the three states; there is no fallthrough. */
export const resolve = ({selfPackageRoot, found, alreadyDelegated}: ResolveInput): Resolution => {
	if (alreadyDelegated) return {_tag: "run-here", why: `already delegated (${DELEGATED_ENV} set)`};
	if (found === undefined) return {_tag: "run-here", why: "no repo-local install above the cwd"};
	if (found.packageRoot === selfPackageRoot)
		return {_tag: "run-here", why: "the repo-local install is this copy"};
	return {_tag: "delegate", to: found};
};

/**
 * One stderr line naming which copy serves this invocation and where it lives.
 *
 * Emitted only under {@link DEBUG_ENV}. Without a trace the delegation is unobservable from the
 * outside — the two copies print identical bytes, which is the point of the design and also what
 * makes "did it delegate?" unanswerable. turbo's shim solves it the same way.
 */
export const DEBUG_ENV = "FABRIKA_CLI_DEBUG";

export const traceLine = (selfPackageRoot: string, resolution: Resolution): string =>
	resolution._tag === "delegate"
		? `fabrika-cli: global at ${selfPackageRoot} — delegating to the repo-local install at ${resolution.to.packageRoot} (${resolution.to.binPath})`
		: `fabrika-cli: running here, at ${selfPackageRoot} — ${resolution.why}`;

export interface SpawnInput {
	readonly execPath: string;
	readonly binPath: string;
	/** The verb and its flags — this process's argv with the node binary and the bin stripped. */
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
}

/**
 * Run the repo-local bin as a child and return its exit code.
 *
 * Stdio is inherited on all three descriptors, so the delegation is invisible to a caller: a verb
 * reading stdin still reads the real fd 0, and its stdout is the same bytes at the same fd. That is
 * what keeps the CLI's own IO contract intact across the hop.
 */
export const spawnDelegate = ({
	execPath,
	binPath,
	args,
	cwd,
}: SpawnInput): Effect.Effect<number, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(execPath, [binPath, ...args], {
				cwd,
				env: {[DELEGATED_ENV]: "1"},
				extendEnv: true,
				detached: false,
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
			return Number(yield* handle.exitCode);
		}),
	).pipe(
		// A spawn that never happened must not read as the child's own verdict. `2` is this package's
		// reserved "could not resolve an implementation" code, distinct from `1` (a verb's usage
		// error) and from `127` (nothing ran at all) — see the convention doc's rule 3 table.
		Effect.catchTag("PlatformError", (cause) =>
			Effect.sync(() => {
				console.error(
					`fabrika-cli: found a repo-local install but could not run it.\n` +
						`  tried: ${execPath} ${binPath}\n` +
						`  cause: ${cause.message}`,
				);
				return 2;
			}),
		),
	);
