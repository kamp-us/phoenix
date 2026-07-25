/**
 * The `readme-guard` filesystem gate — the IO seam behind #938/#939's "every
 * packages/* workspace member carries a README.md" check, split from `command.ts`
 * so it is crossable in unit tests over a fake repo dir rather than only by
 * spawning the bin (the core-in-its-own-file idiom; #855).
 *
 * `checkReadmes` is the CI gate: it grounds its scope in `pnpm-workspace.yaml`
 * (asserting `packages/*` is a declared member glob), enumerates the immediate
 * subdirectories of `packages/`, gathers `package.json`/`README.md` presence for
 * each, and delegates the verdict to the pure core (`readme-guard.ts`). It fails
 * `CheckFailed` (exit non-zero) when a real member lacks a README OR when zero
 * members are in scope (fail-closed, ADR 0092). A directory/file IO failure is an
 * `IoError` (also non-zero — both failures, undistinguished, per the bin's contract).
 *
 * All directory/file/path IO goes through the Effect `FileSystem`/`Path` seam (over the
 * bin's `NodeServices.layer`), so a gate `unit` test crosses an in-memory/real fs rather
 * than welding to `node:fs` — see `.patterns/effect-platform-access.md`. A fs fault folds
 * `PlatformError` → the `IoError` this gate already carries.
 */
import {Console, Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {
	judge,
	type PackageDirCandidate,
	parseWorkspacePackageGlobs,
	renderReport,
} from "./readme-guard.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

/** The workspace glob that scopes this guard — the convention is about `packages/*` specifically. */
const PACKAGES_GLOB = "packages/*";
const PACKAGES_DIR = "packages";

/**
 * Enumerate the immediate subdirectories of `<root>/packages` into the pure core's
 * candidate shape — each carrying whether it holds a `package.json` (⇒ a real
 * workspace member, not a dead shell) and a `README.md`.
 */
const enumeratePackageCandidates = (
	root: string,
): Effect.Effect<ReadonlyArray<PackageDirCandidate>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const base = path.join(root, PACKAGES_DIR);
		return yield* Effect.gen(function* () {
			const candidates: Array<PackageDirCandidate> = [];
			for (const name of yield* fs.readDirectory(base)) {
				// `fs.stat` follows symlinks (matching the old statSync), so a symlink-to-dir
				// still counts; skip plain files.
				const abs = path.join(base, name);
				if ((yield* fs.stat(abs)).type !== "Directory") continue;
				candidates.push({
					dir: `${PACKAGES_DIR}/${name}`,
					hasPackageJson: yield* fs.exists(path.join(abs, "package.json")),
					hasReadme: yield* fs.exists(path.join(abs, "README.md")),
				});
			}
			return candidates;
		}).pipe(Effect.mapError((cause) => new IoError({path: base, cause})));
	});

/** Read `pnpm-workspace.yaml` and assert `packages/*` is a declared member glob. */
const assertPackagesGlobDeclared = (
	root: string,
): Effect.Effect<void, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const workspacePath = path.join(root, "pnpm-workspace.yaml");
		const text = yield* fs
			.readFileString(workspacePath, "utf8")
			.pipe(Effect.mapError((cause) => new IoError({path: workspacePath, cause})));
		const globs = parseWorkspacePackageGlobs(text);
		if (!globs.includes(PACKAGES_GLOB)) {
			// The workspace no longer declares packages/* — the guard's scope assumption
			// is broken, so fail closed rather than scan a phantom directory.
			return yield* Effect.fail(
				new CheckFailed({
					reason: `readme-guard: pnpm-workspace.yaml does not declare the \`${PACKAGES_GLOB}\` member glob (found: ${globs.join(", ") || "<none>"}) — the guard's scope assumption is broken, fail-closed (ADR 0092).`,
				}),
			);
		}
	});

/**
 * The CI gate: succeed when every `packages/*` workspace member (a dir with a
 * `package.json`) carries a `README.md`, else `CheckFailed`. Fails closed on zero
 * members in scope (ADR 0092).
 */
export const checkReadmes = (
	root: string,
): Effect.Effect<void, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		yield* assertPackagesGlobDeclared(root);
		const candidates = yield* enumeratePackageCandidates(root);
		const verdict = judge(candidates);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
