/**
 * The `publish-isolation-guard` filesystem gate — the IO seam behind ADR 0201 §3's
 * "every published pipeline package is installable in isolation" check, split from
 * `command.ts` so it's crossable in unit tests over a fake repo dir rather than only
 * by spawning the bin (the core-in-its-own-file idiom; #855).
 *
 * `checkPublishIsolation` is the CI gate. It (1) derives the published-package set
 * from `.github/workflows/publish.yml`'s release-tag grammar, (2) enumerates the
 * workspace members declared in `pnpm-workspace.yaml`, (3) maps the tag prefixes onto
 * members by unscoped package name, and (4) delegates the verdict to the pure core
 * (`publish-isolation-guard.ts`). It fails `CheckFailed` (exit non-zero) when a
 * published package links a private/unpublished `@kampus/*` dep or a `workspace:*`
 * specifier, when a tag prefix maps to no member (publish.yml/workspace drift), or
 * when zero published packages are in scope (fail-closed, ADR 0092). A directory/file
 * IO failure is an `IoError` (also non-zero — both failures, undistinguished, per the
 * bin's contract).
 */
import {Console, Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {
	judge,
	manifestRuntimeDeps,
	type PublishedManifest,
	parsePublishedTagPrefixes,
	parseWorkspacePackageGlobs,
	renderReport,
	resolvePublished,
} from "./publish-isolation-guard.ts";

/** Repo-relative path to the release pipeline that defines which packages publish. */
const PUBLISH_WORKFLOW = ".github/workflows/publish.yml";

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
 * Expand the declared workspace globs into repo-relative `package.json` paths. Each
 * glob is either a `<dir>/*` member glob (enumerate immediate subdirs that carry a
 * `package.json`) or a literal member path. The root `package.json` is NOT in scope —
 * the root workspace never publishes, so it can't be a published pipeline package.
 *
 * All directory/path IO goes through the Effect `FileSystem`/`Path` seam (over the
 * bin's `NodeServices.layer`), so a gate `unit` test substitutes an in-memory fs for
 * real disk (.patterns/effect-platform-access.md); a fs fault folds `PlatformError`
 * → the `IoError` this gate already carries. This is the one why-note for the file's
 * platform-seam — the other IO helpers below follow the same shape.
 */
const enumerateMemberPaths = (
	root: string,
	globs: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const paths = new Set<string>();
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

/** Read + parse each member path into the pure core's `PublishedManifest` shape (runtime deps only). */
const readMembers = (
	root: string,
	paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<PublishedManifest>, IoError, FileSystem.FileSystem | Path.Path> =>
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
							try: (): PublishedManifest => {
								const pkg = JSON.parse(text) as Record<string, unknown>;
								return {
									path: rel,
									name: typeof pkg.name === "string" ? pkg.name : rel,
									deps: manifestRuntimeDeps(pkg),
								};
							},
							catch: (cause) => new IoError({path: abs, cause}),
						}),
					),
				);
			},
			{concurrency: 1},
		);
	});

const readTextRelative = (
	root: string,
	rel: string,
): Effect.Effect<string, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const target = path.join(root, rel);
		return yield* fs
			.readFileString(target, "utf8")
			.pipe(Effect.mapError((cause) => new IoError({path: target, cause})));
	});

/**
 * The CI gate: succeed when every published pipeline package (derived from
 * publish.yml, mapped to workspace members) links no private/unpublished `@kampus/*`
 * dep or `workspace:*` specifier, else `CheckFailed`. Fails closed on a tag prefix
 * with no matching member (drift) and on zero published packages (ADR 0092).
 */
export const checkPublishIsolation = (
	root: string,
): Effect.Effect<void, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const workflowText = yield* readTextRelative(root, PUBLISH_WORKFLOW);
		const prefixes = parsePublishedTagPrefixes(workflowText);
		const globs = parseWorkspacePackageGlobs(yield* readTextRelative(root, "pnpm-workspace.yaml"));
		const memberPaths = yield* enumerateMemberPaths(root, globs);
		const members = yield* readMembers(root, memberPaths);
		const {published, unmatchedPrefixes} = resolvePublished(prefixes, members);
		if (unmatchedPrefixes.length > 0) {
			// Drift: publish.yml names a release tag whose prefix maps to no workspace
			// member. Fail closed rather than silently narrow scope — the derived set must
			// stay honest against publish.yml (the criterion's "kept in sync with it").
			return yield* Effect.fail(
				new CheckFailed({
					reason:
						`publish-isolation-guard: publish.yml release-tag prefix(es) [${unmatchedPrefixes.join(", ")}] ` +
						"map to no workspace member — fail-closed. The tag grammar and the package name (unscoped) have drifted; " +
						"re-sync publish.yml's `<name>-v<version>` grammar with the package's name.",
				}),
			);
		}
		const verdict = judge(published);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
