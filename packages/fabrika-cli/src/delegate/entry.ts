/**
 * The bootstrap half of the delegation — where the process globals enter and where the process
 * leaves when a repo-local install serves the invocation.
 *
 * Everything decidable lives in [`root.ts`](./root.ts), [`local.ts`](./local.ts) and
 * [`resolve.ts`](./resolve.ts) as Effects over substitutable services. This file is the boundary
 * that reads `process` and calls `process.exit`, so nothing under test has to.
 */
import {NodeServices} from "@effect/platform-node";
import {Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {VERSION} from "../version.ts";
import {declaredVersion, probeLocalInstall} from "./local.ts";
import {
	DEBUG_ENV,
	foreignCheckoutRefusal,
	GLOBAL_WARNING_DISABLED_ENV,
	globalWarning,
	resolve,
	SKIP_INFER_ENV,
	SKIP_INFER_FLAG,
	spawnDelegate,
	traceLine,
} from "./resolve.ts";
import {discoverRepoRoot, originOf} from "./root.ts";

/** The running copy's own root could not be canonicalized — fatal, never a fallback. */
export class RealPathFailed extends Schema.TaggedErrorClass<RealPathFailed>()(
	"fabrika-cli/RealPathFailed",
	{path: Schema.String, reason: Schema.String},
) {}

/** `<package root>/src/delegate/entry.ts` — the package root is two levels up. */
const packageRootUrl = new URL("../../", import.meta.url);

/**
 * Strip the recursion guard from argv, reporting whether it was there.
 *
 * The flag is consumed here so no verb ever sees it: it is an argument to the *shim*, not to the
 * CLI, and a verb handed an unknown flag would refuse.
 */
export const takeSkipInfer = (
	argv: Array<string>,
	env: Record<string, string | undefined>,
): boolean => {
	const at = argv.indexOf(SKIP_INFER_FLAG);
	if (at !== -1) argv.splice(at, 1);
	return at !== -1 || env[SKIP_INFER_ENV] !== undefined;
};

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const own = yield* path.fromFileUrl(packageRootUrl);
	// No `orElseSucceed` fallback here on purpose: an un-canonicalizable own root makes the self-check
	// compare two paths that may name the same install, which is precisely how a copy delegates to
	// itself forever. Failing is the only honest answer (#4784).
	const selfPackageRoot = yield* fs
		.realPath(own)
		.pipe(
			Effect.catchTag(
				"PlatformError",
				(cause) => new RealPathFailed({path: own, reason: cause.message}),
			),
		);
	// Both walks stay on the `E` channel, so an ancestor that cannot be probed ends the run with the
	// diagnostic below. An unreadable origin must never soften into "no checkout", which reads as the
	// global install and re-opens the branch #4956 closed.
	const selfOrigin = yield* originOf(selfPackageRoot);
	const invocationDir = process.cwd();
	const repoRoot = yield* discoverRepoRoot(invocationDir);
	const local = repoRoot === undefined ? undefined : yield* probeLocalInstall(repoRoot);
	const resolution = resolve({selfPackageRoot, selfOrigin, repoRoot, local});

	if (process.env[DEBUG_ENV] !== undefined) console.error(traceLine(selfPackageRoot, resolution));

	if (resolution._tag === "refuse-foreign-checkout") {
		console.error(foreignCheckoutRefusal(resolution));
		return {_tag: "exited", status: 2} as const;
	}
	if (resolution._tag === "run-here") return undefined;
	if (resolution._tag === "warn-and-run-here") {
		if (process.env[GLOBAL_WARNING_DISABLED_ENV] === undefined) {
			console.error(
				globalWarning({
					repoRoot: resolution.repoRoot,
					reason: resolution.reason,
					globalVersion: VERSION,
					declared: yield* declaredVersion(resolution.repoRoot),
				}),
			);
		}
		return undefined;
	}

	return yield* spawnDelegate({
		execPath: process.execPath,
		binPath: resolution.to.binPath,
		args: process.argv.slice(2),
		// The child's cwd is the REPO ROOT, and the user's cwd travels as an env var. turbo does this
		// deliberately: an older local binary that does not know the flag would choke on it, whereas an
		// env var it never reads is harmless.
		cwd: repoRoot as string,
		invocationDir,
	});
});

/**
 * Hand the invocation to the repo-local install when the cwd is inside a repo that pins one.
 *
 * Resolves when this copy should serve the invocation itself; otherwise it never resolves, because
 * the process exits with the child's status — or re-raises the child's own signal, so a Ctrl-C'd
 * delegation is reported to the shell as a Ctrl-C rather than as some exit code.
 */
export const delegateOrRunHere = async (): Promise<void> => {
	// Both recursion guards are read BEFORE any filesystem work: a delegated child must not pay for
	// the ancestor walk, and must not be able to exit 2 on a walk fault it should never have
	// performed. The self-check in `resolve` is the second, independent guard.
	if (takeSkipInfer(process.argv, process.env)) return;

	const outcome = await Effect.runPromise(
		program.pipe(
			Effect.catchTags({
				"fabrika-cli/ReadFailed": (cause) =>
					Effect.succeed({failed: cause.path, reason: cause.reason}),
				"fabrika-cli/RealPathFailed": (cause) =>
					Effect.succeed({failed: cause.path, reason: cause.reason}),
				BadArgument: (cause) =>
					Effect.succeed({failed: packageRootUrl.href, reason: cause.message}),
			}),
			Effect.provide(NodeServices.layer),
		),
	);
	if (outcome === undefined) return;
	if ("_tag" in outcome) {
		if (outcome._tag === "signalled") {
			process.kill(process.pid, outcome.signal);
			return;
		}
		process.exit(outcome.status);
	}
	console.error(
		`fabrika: could not resolve which copy to run.\n` +
			`  looked for a repo root above your cwd (${process.cwd()}) and above the invoked copy (${packageRootUrl.href})\n` +
			`  stopped at: ${outcome.failed}\n` +
			`  cause: ${outcome.reason}`,
	);
	process.exit(2);
};
