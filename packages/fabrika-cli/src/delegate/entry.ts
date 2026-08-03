/**
 * The bootstrap half of the delegation — where the process globals enter and where the process
 * leaves when a repo-local install serves the invocation.
 *
 * Everything decidable lives in [`discover.ts`](./discover.ts) and [`resolve.ts`](./resolve.ts) as
 * Effects over substitutable services. This file is the boundary that reads `process` and calls
 * `process.exit`, so nothing under test has to.
 */
import {NodeServices} from "@effect/platform-node";
import {Effect, FileSystem, Path} from "effect";
import {discoverRepoLocalInstall} from "./discover.ts";
import {DEBUG_ENV, DELEGATED_ENV, resolve, spawnDelegate, traceLine} from "./resolve.ts";

/** `<package root>/{src,dist}/delegate/entry.{ts,js}` — both layouts sit two levels down. */
const packageRootUrl = new URL("../../", import.meta.url);

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const own = yield* path.fromFileUrl(packageRootUrl);
	const selfPackageRoot = yield* fs
		.realPath(own)
		.pipe(Effect.orElseSucceed(() => path.resolve(own)));
	const cwd = process.cwd();
	const found = yield* discoverRepoLocalInstall(cwd);
	const resolution = resolve({
		selfPackageRoot,
		found,
		alreadyDelegated: process.env[DELEGATED_ENV] !== undefined,
	});
	if (process.env[DEBUG_ENV] !== undefined) {
		console.error(traceLine(selfPackageRoot, resolution));
	}
	if (resolution._tag === "run-here") return undefined;
	return yield* spawnDelegate({
		execPath: process.execPath,
		binPath: resolution.to.binPath,
		args: process.argv.slice(2),
		cwd,
	});
});

/**
 * Hand the invocation to the repo-local install when the cwd is inside a repo that pins one.
 *
 * Resolves when this copy should serve the invocation itself; otherwise it never resolves, because
 * the process exits with the child's status. A walk that could not be *performed* — an unreadable
 * ancestor, a manifest that is not a package — exits `2` after saying what it tried, rather than
 * quietly running a version the repo did not pin.
 */
export const delegateOrRunHere = async (): Promise<void> => {
	const outcome = await Effect.runPromise(
		program.pipe(
			Effect.catchTags({
				"fabrika-cli/ReadFailed": (cause) =>
					Effect.succeed({failed: cause.path, reason: cause.reason}),
				"fabrika-cli/MalformedManifest": (cause) =>
					Effect.succeed({failed: cause.path, reason: cause.reason}),
				BadArgument: (cause) =>
					Effect.succeed({failed: packageRootUrl.href, reason: cause.message}),
			}),
			Effect.provide(NodeServices.layer),
		),
	);
	if (outcome === undefined) return;
	if (typeof outcome === "number") process.exit(outcome);
	console.error(
		`fabrika-cli: could not resolve which copy to run.\n` +
			`  looked for a repo-local install above: ${process.cwd()}\n` +
			`  stopped at: ${outcome.failed}\n` +
			`  cause: ${outcome.reason}`,
	);
	process.exit(2);
};
