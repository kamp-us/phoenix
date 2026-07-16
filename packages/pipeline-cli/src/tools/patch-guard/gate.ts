/**
 * The `patch-guard` filesystem gate (ADR 0038 forcing function) — the IO seam behind
 * the "every maintained `pnpm patch` carries a behavior pin" check, split from
 * `command.ts` so it is crossable in unit tests over a fake repo dir rather than only
 * by spawning the bin (the core-in-its-own-file idiom; #855).
 *
 * `checkPatchGuard` is the CI gate: it reads the `patchedDependencies` map from
 * `pnpm-workspace.yaml` (the authoritative maintained-patch set), walks the repo's test
 * tree gathering every `// @patch-pin: <name>@<version>` marker, and delegates the
 * verdict to the pure core (`patch-guard.ts`). It fails `CheckFailed` (exit non-zero)
 * on a patched dep with no pin, a stale pin marker, or zero patchedDependencies in
 * scope (fail-closed, ADR 0092). A directory/file IO failure is an `IoError` (also
 * non-zero — both failures, undistinguished, per the bin's contract).
 */
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join, relative, sep} from "node:path";
import {Console, Data, Effect} from "effect";
import {
	judge,
	type PatchedDep,
	type PinMarker,
	parsePatchedDependencies,
	parsePinMarkers,
	renderReport,
} from "./patch-guard.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{readonly reason: string}> {}

// Dirs never worth walking for test files: dependency trees, VCS, nested agent
// worktrees/checkouts (present only in a dev tree, never on a fresh CI checkout), and
// build output. Excluding `.claude` keeps the scan to THIS checkout's own test tree —
// a sibling worktree's markers are another checkout's business, not this scan's.
const IGNORE_DIRS = new Set([
	"node_modules",
	".git",
	".claude",
	"dist",
	"build",
	".turbo",
	".wrangler",
	"coverage",
]);

/** The behavior pin lives on a test — scope the marker scan to test files (any tier). */
const isTestFile = (name: string): boolean => /\.test\.(ts|tsx)$/.test(name);

const readWorkspacePatches = (root: string): Effect.Effect<ReadonlyArray<PatchedDep>, IoError> =>
	Effect.try({
		try: () => parsePatchedDependencies(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")),
		catch: (cause) => new IoError({path: join(root, "pnpm-workspace.yaml"), cause}),
	});

/**
 * Walk the repo's test tree and gather every `@patch-pin:` marker. Recurses from `root`
 * skipping `IGNORE_DIRS` at any depth, reads each `*.test.ts(x)` file, and parses its
 * markers with a repo-relative (POSIX-normalized) path so the report is stable across
 * platforms and carries no absolute path.
 */
const gatherMarkers = (root: string): Effect.Effect<ReadonlyArray<PinMarker>, IoError> =>
	Effect.try({
		try: () => {
			const markers: Array<PinMarker> = [];
			const walk = (dir: string): void => {
				for (const entry of readdirSync(dir, {withFileTypes: true})) {
					const abs = join(dir, entry.name);
					if (entry.isDirectory()) {
						if (!IGNORE_DIRS.has(entry.name)) walk(abs);
						continue;
					}
					if (!statSync(abs).isFile() || !isTestFile(entry.name)) continue;
					const relPath = relative(root, abs).split(sep).join("/");
					markers.push(...parsePinMarkers(readFileSync(abs, "utf8"), relPath));
				}
			};
			walk(root);
			return markers;
		},
		catch: (cause) => new IoError({path: root, cause}),
	});

/**
 * The CI gate: succeed when every maintained patch carries ≥1 matching `@patch-pin:`
 * marker and no marker is stale, else `CheckFailed`. Fails closed on zero
 * patchedDependencies in scope (ADR 0092).
 */
export const checkPatchGuard = (root: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const patched = yield* readWorkspacePatches(root);
		const markers = yield* gatherMarkers(root);
		const verdict = judge(patched, markers);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
