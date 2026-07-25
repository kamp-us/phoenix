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
 *
 * All directory/path IO goes through the Effect `FileSystem`/`Path` seam (over the bin's
 * `NodeServices.layer`), so a gate `unit` test substitutes an in-memory fs for real disk
 * (.patterns/effect-platform-access.md); a fs fault folds `PlatformError` → the `IoError`
 * this gate already carries.
 */
import {Console, Effect, FileSystem, Path, type PlatformError} from "effect";
import * as Schema from "effect/Schema";
import {
	judge,
	type PatchedDep,
	type PinMarker,
	parsePatchedDependencies,
	parsePinMarkers,
	renderReport,
} from "./patch-guard.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

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

const readWorkspacePatches = (
	root: string,
): Effect.Effect<ReadonlyArray<PatchedDep>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const target = path.join(root, "pnpm-workspace.yaml");
		const text = yield* fs
			.readFileString(target, "utf8")
			.pipe(Effect.mapError((cause) => new IoError({path: target, cause})));
		return yield* Effect.try({
			try: () => parsePatchedDependencies(text),
			catch: (cause) => new IoError({path: target, cause}),
		});
	});

/**
 * Walk the repo's test tree and gather every `@patch-pin:` marker. Recurses from `root`
 * skipping `IGNORE_DIRS` at any depth, reads each `*.test.ts(x)` file, and parses its
 * markers with a repo-relative (POSIX-normalized) path so the report is stable across
 * platforms and carries no absolute path.
 */
const gatherMarkers = (
	root: string,
): Effect.Effect<ReadonlyArray<PinMarker>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const markers: Array<PinMarker> = [];
		const walk = (dir: string): Effect.Effect<void, PlatformError.PlatformError> =>
			Effect.gen(function* () {
				for (const name of yield* fs.readDirectory(dir)) {
					const abs = path.join(dir, name);
					const stat = yield* fs.stat(abs);
					if (stat.type === "Directory") {
						// A symlinked dir is NEVER recursed: `fs.stat` follows links, but the
						// pre-migration `Dirent.isDirectory()` was lstat-based, so a link-to-dir
						// fell through and was skipped. v4's FileSystem exposes no `lstat`, and
						// `readDirectory` takes no `withFileTypes` — but `readLink` succeeds only
						// on a link, which is the equivalent test. Recursing one would both widen
						// the pin scan (a guard failing OPEN) and admit a symlink cycle, since
						// IGNORE_DIRS screens by name, not link-ness. Symlinked FILES stay in
						// scope, as at base — hence the guard sits on this arm only.
						const isSymlink = yield* fs.readLink(abs).pipe(
							Effect.as(true),
							Effect.orElseSucceed(() => false),
						);
						if (!isSymlink && !IGNORE_DIRS.has(name)) yield* walk(abs);
						continue;
					}
					if (stat.type !== "File" || !isTestFile(name)) continue;
					const relPath = path.relative(root, abs).split(path.sep).join("/");
					markers.push(...parsePinMarkers(yield* fs.readFileString(abs, "utf8"), relPath));
				}
			});
		yield* walk(root);
		return markers;
	}).pipe(Effect.mapError((cause) => new IoError({path: root, cause})));

/**
 * The CI gate: succeed when every maintained patch carries ≥1 matching `@patch-pin:`
 * marker and no marker is stale, else `CheckFailed`. Fails closed on zero
 * patchedDependencies in scope (ADR 0092).
 */
export const checkPatchGuard = (
	root: string,
): Effect.Effect<void, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
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
