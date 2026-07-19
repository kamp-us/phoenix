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
import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {Console, Effect} from "effect";
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
 */
const enumerateManifestPaths = (
	root: string,
	globs: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, IoError> =>
	Effect.try({
		try: () => {
			const paths = new Set<string>();
			if (existsSync(join(root, "package.json"))) paths.add("package.json");
			for (const glob of globs) {
				if (glob.endsWith("/*")) {
					const parent = glob.slice(0, -2);
					const base = join(root, parent);
					if (!existsSync(base)) continue;
					for (const entry of readdirSync(base, {withFileTypes: true})) {
						const abs = join(base, entry.name);
						if (!statSync(abs).isDirectory()) continue;
						if (existsSync(join(abs, "package.json")))
							paths.add(`${parent}/${entry.name}/package.json`);
					}
				} else if (existsSync(join(root, glob, "package.json"))) {
					paths.add(`${glob}/package.json`);
				}
			}
			return [...paths].sort();
		},
		catch: (cause) => new IoError({path: root, cause}),
	});

/** Read + parse each manifest path into the pure core's `PackageManifest` shape. */
const readManifests = (
	root: string,
	paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<PackageManifest>, IoError> =>
	Effect.forEach(
		paths,
		(path) =>
			Effect.try({
				try: (): PackageManifest => {
					const pkg = JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;
					return {path, deps: manifestDeps(pkg)};
				},
				catch: (cause) => new IoError({path: join(root, path), cause}),
			}),
		{concurrency: 1},
	);

const readWorkspaceGlobs = (root: string): Effect.Effect<ReadonlyArray<string>, IoError> =>
	Effect.try({
		try: () => parseWorkspacePackageGlobs(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")),
		catch: (cause) => new IoError({path: join(root, "pnpm-workspace.yaml"), cause}),
	});

/**
 * The CI gate: succeed when every governed dep across the root manifest and every
 * real workspace member is on `catalog:`/`workspace:` (or allowlisted), else
 * `CheckFailed`. Fails closed on zero manifests in scope (ADR 0092).
 */
export const checkCatalog = (
	root: string,
	allowlist: ReadonlyArray<AllowlistEntry> = DEFAULT_ALLOWLIST,
): Effect.Effect<void, IoError | CheckFailed> =>
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
