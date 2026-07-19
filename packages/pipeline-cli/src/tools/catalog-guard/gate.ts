/**
 * The `catalog-guard` filesystem gate — the IO seam behind #2737's "every
 * package.json dep via catalog:" check, split from `command.ts` so it is crossable
 * in unit tests over a fake repo dir rather than only by spawning the bin (the
 * core-in-its-own-file idiom; #855).
 *
 * `checkCatalog` is the CI gate: it grounds its scope in `pnpm-workspace.yaml`'s
 * declared member globs, enumerates every real workspace member (a dir with a
 * `package.json`) plus the root manifest, reads each `package.json`'s governed dep
 * fields, and delegates the verdict to the pure core (`catalog-guard.ts`). It fails
 * `CheckFailed` (exit non-zero) when a dep pins a hardcoded version OR when zero
 * manifests are in scope (fail-closed, ADR 0092). A directory/file IO failure is an
 * `IoError` (also non-zero — both failures, undistinguished, per the bin's contract).
 */
import {Console, Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {
	type AllowlistEntry,
	DEFAULT_ALLOWLIST,
	judge,
	manifestDeps,
	type PackageManifest,
	parseWorkspacePackageGlobs,
	renderReport,
} from "./catalog-guard.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

/**
 * Expand the declared workspace globs into repo-relative `package.json` paths, plus
 * the root manifest. Each glob is either a `<dir>/*` member glob (enumerate immediate
 * subdirs that carry a `package.json`) or a literal member path. The root
 * `package.json` is always in scope — its deps are governed by the catalog rule too.
 *
 * All directory/path IO goes through the Effect `FileSystem`/`Path` seam (over the
 * bin's `NodeServices.layer`), so a gate `unit` test substitutes an in-memory fs for
 * the real disk (.patterns/effect-platform-access.md); a fs fault folds `PlatformError`
 * → the `IoError` this gate already carries. This is the one why-note for the file's
 * platform-seam migration — the other IO helpers below follow the same shape.
 */
const enumerateManifestPaths = (
	root: string,
	globs: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const paths = new Set<string>();
		if (yield* fs.exists(path.join(root, "package.json"))) paths.add("package.json");
		for (const glob of globs) {
			if (glob.endsWith("/*")) {
				const parent = glob.slice(0, -2);
				const base = path.join(root, parent);
				if (!(yield* fs.exists(base))) continue;
				for (const name of yield* fs.readDirectory(base)) {
					const abs = path.join(base, name);
					if ((yield* fs.stat(abs)).type !== "Directory") continue;
					if (yield* fs.exists(path.join(abs, "package.json")))
						paths.add(`${parent}/${name}/package.json`);
				}
			} else if (yield* fs.exists(path.join(root, glob, "package.json"))) {
				paths.add(`${glob}/package.json`);
			}
		}
		return [...paths].sort();
	}).pipe(Effect.mapError((cause) => new IoError({path: root, cause})));

/** Read + parse each manifest path into the pure core's `PackageManifest` shape. */
const readManifests = (
	root: string,
	paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<PackageManifest>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		return yield* Effect.forEach(
			paths,
			(rel) => {
				const abs = path.join(root, rel);
				return fs.readFileString(abs, "utf8").pipe(
					Effect.mapError((cause) => new IoError({path: abs, cause})),
					Effect.flatMap((text) =>
						Effect.try({
							try: (): PackageManifest => ({
								path: rel,
								deps: manifestDeps(JSON.parse(text) as Record<string, unknown>),
							}),
							catch: (cause) => new IoError({path: abs, cause}),
						}),
					),
				);
			},
			{concurrency: 1},
		);
	});

const readWorkspaceGlobs = (
	root: string,
): Effect.Effect<ReadonlyArray<string>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const target = path.join(root, "pnpm-workspace.yaml");
		const text = yield* fs
			.readFileString(target, "utf8")
			.pipe(Effect.mapError((cause) => new IoError({path: target, cause})));
		return yield* Effect.try({
			try: () => parseWorkspacePackageGlobs(text),
			catch: (cause) => new IoError({path: target, cause}),
		});
	});

/**
 * The CI gate: succeed when every governed dep across the root manifest and every
 * real workspace member is on `catalog:`/`workspace:` (or allowlisted), else
 * `CheckFailed`. Fails closed on zero manifests in scope (ADR 0092).
 */
export const checkCatalog = (
	root: string,
	allowlist: ReadonlyArray<AllowlistEntry> = DEFAULT_ALLOWLIST,
): Effect.Effect<void, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const globs = yield* readWorkspaceGlobs(root);
		const paths = yield* enumerateManifestPaths(root, globs);
		const manifests = yield* readManifests(root, paths);
		const verdict = judge(manifests, allowlist);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
