/**
 * Walk up from a directory looking for a repo-local install of this package.
 *
 * This is the shape turbo ships: one binary, installed globally, that hands control to the copy the
 * repo pins when it is standing in one. The walk reads a **manifest**, never a heuristic — a
 * candidate counts only when `node_modules/@kampus/fabrika-cli/package.json` is there and declares
 * its own `bin`. So the two outcomes are "a real installed package" and "nothing here"; there is no
 * third outcome where a file exists and cannot run (#4784).
 *
 * A probe that could not be *performed* fails on the `E` channel rather than answering "absent" —
 * an unreadable ancestor would otherwise silently downgrade a pinned repo to the global.
 */
import {Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {exists, ReadFailed, readFile} from "../io/fs.ts";

/** The npm name the walk looks for, and the bin key inside that package's manifest. */
export const PACKAGE_NAME = "@kampus/fabrika-cli";
export const BIN_NAME = "fabrika-cli";

/** A repo-local install found by the walk: a real package with a declared entry point. */
export interface LocalInstall {
	/** The install's real path — symlinks resolved, so it compares against a running package root. */
	readonly packageRoot: string;
	readonly manifestPath: string;
	/** Absolute, resolved from the manifest's own `bin` field against {@link packageRoot}. */
	readonly binPath: string;
}

/** A `package.json` was found and read but does not declare a `fabrika-cli` bin. */
export class MalformedManifest extends Schema.TaggedErrorClass<MalformedManifest>()(
	"fabrika-cli/MalformedManifest",
	{path: Schema.String, reason: Schema.String},
) {}

/**
 * `from` and every ancestor up to the filesystem root, nearest first.
 *
 * Nearest-first is the whole ordering rule: a nested package that pins its own copy wins over the
 * workspace root above it, the same way `require` resolution does.
 */
export const ancestors = (path: Path.Path, from: string): ReadonlyArray<string> => {
	const walked: string[] = [];
	let current = path.resolve(from);
	for (;;) {
		walked.push(current);
		const parent = path.dirname(current);
		if (parent === current) return walked;
		current = parent;
	}
};

const binFieldOf = (manifestPath: string, text: string) =>
	Effect.try({
		try: () => JSON.parse(text) as unknown,
		catch: () => new MalformedManifest({path: manifestPath, reason: "not valid JSON"}),
	}).pipe(
		Effect.flatMap((parsed) => {
			const bin = (parsed as {bin?: unknown} | null)?.bin;
			if (typeof bin === "string") return Effect.succeed(bin);
			const named = (bin as Record<string, unknown> | undefined)?.[BIN_NAME];
			if (typeof named === "string") return Effect.succeed(named);
			return Effect.fail(
				new MalformedManifest({
					path: manifestPath,
					reason: `declares no "${BIN_NAME}" bin`,
				}),
			);
		}),
	);

/**
 * The nearest repo-local install at or above `from`, or `undefined` when there is none.
 *
 * `undefined` is a **proven** absence: every ancestor was probed and none held the package. A probe
 * that itself failed leaves on the `E` channel instead.
 */
export const discoverRepoLocalInstall = (
	from: string,
): Effect.Effect<
	LocalInstall | undefined,
	ReadFailed | MalformedManifest,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const fs = yield* FileSystem.FileSystem;
		for (const dir of ancestors(path, from)) {
			const packageRoot = path.join(dir, "node_modules", ...PACKAGE_NAME.split("/"));
			const manifestPath = path.join(packageRoot, "package.json");
			if (!(yield* exists(manifestPath))) continue;
			const bin = yield* binFieldOf(manifestPath, yield* readFile(manifestPath));
			// Real path, not the resolved one: pnpm links a workspace package into `node_modules`, so
			// the symlink and the package it points at are the same install under two names. Comparing
			// the unresolved name against a running package root would make a repo-local copy delegate
			// to itself forever.
			const real = yield* fs
				.realPath(packageRoot)
				.pipe(
					Effect.catchTag(
						"PlatformError",
						(cause) => new ReadFailed({path: packageRoot, reason: cause.message}),
					),
				);
			return {packageRoot: real, manifestPath, binPath: path.resolve(real, bin)};
		}
		return undefined;
	});
