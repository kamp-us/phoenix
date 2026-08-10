/**
 * Decide, and then act on, which copy of `fabrika` serves this invocation.
 *
 * The decision is a pure function of four facts — where the running copy lives, *which checkout it
 * belongs to*, whether the cwd has a repo root, and what that root's install probe said — so every
 * branch is testable without a filesystem.
 *
 * **No branch is both silent and wrong.** No repo root at all runs the global with no warning,
 * deliberately, so global-only invocations still work. A repo root whose local install is missing or
 * corrupt runs the global too, but *says so loudly* — that pairing is the whole design: tiers that
 * can only be right or loudly absent are fine; tiers that can be quietly wrong are the defect
 * (#4784). One tier used to be quietly wrong against that rule and is now a refusal: a copy invoked
 * out of a *different checkout* is not a global install, and delegating it answered from a tree the
 * caller never named (#4956).
 */
import {Effect} from "effect";
import {ChildProcess, type ChildProcessSpawner} from "effect/unstable/process";
import type {LocalInstall, LocalProbe} from "./local.ts";
import type {SelfOrigin} from "./root.ts";

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

export const DEBUG_ENV = "FABRIKA_DEBUG";

export type Resolution =
	| {readonly _tag: "run-here"; readonly why: string}
	| {readonly _tag: "delegate"; readonly to: LocalInstall}
	| {
			readonly _tag: "warn-and-run-here";
			readonly repoRoot: string;
			readonly reason: string;
	  }
	| {
			readonly _tag: "refuse-foreign-checkout";
			readonly selfPackageRoot: string;
			/** The checkout the invoked copy belongs to — never equal to {@link repoRoot}. */
			readonly selfCheckout: string;
			readonly repoRoot: string;
			/** The install the cwd's repo would have answered from, named so the refusal is checkable. */
			readonly wouldHaveRun: LocalInstall;
	  };

export interface ResolveInput {
	/** The real path of the package root the running bin belongs to. */
	readonly selfPackageRoot: string;
	/** Which checkout, if any, {@link selfPackageRoot} belongs to. */
	readonly selfOrigin: SelfOrigin;
	/** `undefined` when the cwd is in no repo at all — the one silent branch. */
	readonly repoRoot: string | undefined;
	readonly local: LocalProbe | undefined;
}

/** Which copy serves this invocation. Total over the five states; there is no fallthrough. */
export const resolve = ({
	selfPackageRoot,
	selfOrigin,
	repoRoot,
	local,
}: ResolveInput): Resolution => {
	if (repoRoot === undefined) return {_tag: "run-here", why: "the cwd is not inside a repo"};
	if (local === undefined || local._tag === "absent")
		return {_tag: "warn-and-run-here", repoRoot, reason: "it has no local install"};
	if (local._tag === "corrupt") return {_tag: "warn-and-run-here", repoRoot, reason: local.reason};
	if (local.install.packageRoot === selfPackageRoot)
		return {_tag: "run-here", why: "the repo-local install is this copy"};
	// Only a copy that belongs to NO checkout is the global install this delegation was designed for.
	// A copy from another checkout reaches the same comparison and used to be indistinguishable from
	// it (#4956) — the refusal is placed here, on the delegate branch alone, so the two loud branches
	// above keep their behaviour and their text exactly.
	if (selfOrigin._tag === "checkout" && selfOrigin.root !== repoRoot)
		return {
			_tag: "refuse-foreign-checkout",
			selfPackageRoot,
			selfCheckout: selfOrigin.root,
			repoRoot,
			wouldHaveRun: local.install,
		};
	return {_tag: "delegate", to: local.install};
};

/**
 * The refusal's text: both checkouts, the answer it declined to give, and the two ways out.
 *
 * Naming the install it *would* have run is what makes the refusal auditable rather than a bare
 * "no" — a reader who expected the delegation can see precisely which copy the cwd resolved to.
 */
export const foreignCheckoutRefusal = ({
	selfPackageRoot,
	selfCheckout,
	repoRoot,
	wouldHaveRun,
}: {
	readonly selfPackageRoot: string;
	readonly selfCheckout: string;
	readonly repoRoot: string;
	readonly wouldHaveRun: LocalInstall;
}): string =>
	[
		"fabrika: refusing to run — the copy you invoked and your cwd are in different checkouts.",
		`  invoked copy: ${selfPackageRoot} (checkout ${selfCheckout})`,
		`  cwd checkout: ${repoRoot}, which resolves ${wouldHaveRun.binPath} (v${wouldHaveRun.version})`,
		"  Delegating would have answered from a checkout you did not name.",
		`  Re-run with the cwd inside ${selfCheckout}, or pass ${SKIP_INFER_FLAG} to make the copy you named serve this invocation.`,
	].join("\n");

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
		`fabrika: running the GLOBAL install (v${globalVersion}) — ${repoRoot} ${reason}.`,
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
			return `fabrika: global at ${selfPackageRoot} — delegating to the repo-local install at ${resolution.to.packageRoot} (${resolution.to.binPath}, v${resolution.to.version})`;
		case "warn-and-run-here":
			return `fabrika: running here, at ${selfPackageRoot} — repo root ${resolution.repoRoot}, but ${resolution.reason}`;
		case "refuse-foreign-checkout":
			return `fabrika: refusing — ${selfPackageRoot} is in checkout ${resolution.selfCheckout}, the cwd is in ${resolution.repoRoot}`;
		case "run-here":
			return `fabrika: running here, at ${selfPackageRoot} — ${resolution.why}`;
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
 * as a `PlatformError` with no structured field for the name, so recovering it from a message is the
 * only way to re-raise the signal on ourselves.
 *
 * **The name is one level down, in the cause chain — never on the `PlatformError` itself.**
 * `NodeChildProcessSpawner`'s `exitCode` deferred builds `new Error("Process interrupted due to
 * receipt of signal: '<sig>'")` and passes it as the `cause` of `PlatformError.systemError`, whose
 * own `message` getter renders `"<tag>: <module>.<method> (<command>)"` and drops it
 * (`@effect/platform-node-shared@4.0.0-beta.92` `NodeChildProcessSpawner` + `internal/utils`'s
 * `handleErrnoException`; `effect`'s `PlatformError.SystemError.message`). This walks the chain and
 * takes the *error* rather than a message string precisely so no caller can read the wrong level
 * again — matching the top-level message compiled fine, passed a pure-function test, and made the
 * signalled branch dead code on every real signal death (#4792). A chain that stops matching must
 * read as "could not tell", never as a clean exit.
 */
const SIGNAL_MESSAGE = /receipt of signal: '([A-Z0-9]+)'/;

export const signalFromError = (error: unknown): NodeJS.Signals | undefined => {
	for (let link: unknown = error; link instanceof Error; link = link.cause) {
		const matched = SIGNAL_MESSAGE.exec(link.message);
		if (matched !== null) return matched[1] as NodeJS.Signals;
	}
	return undefined;
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
			const signal = signalFromError(cause);
			if (signal !== undefined) return Effect.succeed({_tag: "signalled", signal});
			// A spawn that never happened must not read as the child's own verdict. `2` is this
			// package's reserved "could not resolve an implementation" code, distinct from `1` (a
			// verb's usage error) and from `127` (nothing ran at all) — see the convention doc's
			// rule 3 table.
			return Effect.sync(() => {
				console.error(
					`fabrika: found a repo-local install but could not run it.\n` +
						`  tried: ${execPath} ${binPath}\n` +
						`  cause: ${cause.message}`,
				);
				return {_tag: "exited", status: 2};
			});
		}),
	);
