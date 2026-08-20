/**
 * Where the skill roster lives, and what one `SKILL.md` says about itself.
 *
 * **The roster is the plugin's, not the target repo's.** fabrika installs into repos that are not
 * phoenix (#4776), so defaulting to a repo-relative path would make `status menu` empty on
 * precisely the fresh repo this skill onboards. Resolution runs six tiers and prints which one
 * served, so a caller can re-run the read instead of adopting the render.
 *
 * **A roster that resolves and holds zero skills is a fact, not a failure**; a roster that could not
 * be read, or one `SKILL.md` inside it that could not be read, is UNKNOWN. A partial roster is not a
 * roster — the false-absence class of #4105 and #4163.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import {ancestors} from "../delegate/root.ts";
import {exists, isDirectory, readDir, readFile} from "../io/fs.ts";
import {isRecord, parseJson} from "../io/json.ts";

/** Which of the six tiers served the roster. Printed, never assumed. */
export type RosterTier = "explicit" | "env" | "plugin" | "repo" | "checkout" | "cache";

/** Who can reach a skill — the one routing fact a reader cannot infer from a description. */
export type InvocationAxis = "model" | "user";

/** The plugin-manifest directory that marks an installed fabrika plugin root. */
export const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";

/** The in-repo development location of the roster, relative to the repository root. */
export const IN_REPO_ROSTER = "claude-plugins/fabrika/skills";

/**
 * The `name` a cached plugin's manifest must declare to be fabrika's own roster.
 *
 * Matched against the manifest rather than the directory: the cache path carries the *marketplace's*
 * name for the plugin plus a content hash, both of which change without the plugin changing.
 */
export const PLUGIN_NAME = "fabrika";

/**
 * The two markers Claude Code writes beside a cached plugin version, read here and never written.
 *
 * `.orphaned_at` is stamped by the harness's cache sweep on every version the live plugin set no
 * longer references, so its absence is what distinguishes the installed version from the dozens of
 * superseded copies left beside it (49 of them on the machine #6448 was reproduced on, 48 orphaned).
 * `.in_use` marks a version some running session holds; it is a tiebreak and not a filter, because
 * the live version on that same machine carried no `.in_use` at all.
 */
const ORPHANED_MARKER = ".orphaned_at";
const IN_USE_MARKER = ".in_use";

export interface RosterSkill {
	readonly name: string;
	readonly invocation: string;
	readonly invocationAxis: InvocationAxis;
	readonly description: string;
	/** Whether the frontmatter parsed. A `false` row still ships — a dropped row is a false absence. */
	readonly frontmatterReadable: boolean;
	readonly text: string;
}

export type RosterRead =
	| {
			readonly _tag: "Resolved";
			readonly path: string;
			/** The path as printed — relative to its root, so no machine-local path reaches a reader. */
			readonly display: string;
			readonly tier: RosterTier;
			readonly skills: ReadonlyArray<RosterSkill>;
			readonly unreadableFrontmatter: number;
	  }
	/** An **explicitly passed** `--skills-dir` proven absent — a caller error, not a state of the world. */
	| {readonly _tag: "AbsentExplicit"; readonly path: string; readonly display: string}
	/** The roster, or one `SKILL.md` inside it, could not be read. The declaration set is UNKNOWN. */
	| {
			readonly _tag: "Failed";
			readonly path: string;
			readonly display: string;
			readonly reason: string;
	  };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * The `key: value` pairs of a `SKILL.md`'s frontmatter block, or `null` when there is none.
 *
 * Hand-read rather than parsed with a YAML dependency, matching this package's standing shape: the
 * three keys read here — `name`, `description`, `disable-model-invocation` — are plain scalars, and
 * a continuation line is folded into the value above it the way the block quotes them.
 */
export const parseFrontmatter = (text: string): ReadonlyMap<string, string> | null => {
	const block = FRONTMATTER.exec(text);
	if (block?.[1] === undefined) return null;
	const fields = new Map<string, string>();
	let current: string | null = null;
	for (const line of block[1].split("\n")) {
		const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/.exec(line);
		if (pair?.[1] !== undefined) {
			current = pair[1];
			fields.set(current, (pair[2] ?? "").trim());
			continue;
		}
		if (current !== null && line.trim() !== "") {
			fields.set(current, `${fields.get(current) ?? ""} ${line.trim()}`.trim());
		}
	}
	return fields;
};

/** One roster row from a `SKILL.md`'s bytes. Unparseable frontmatter yields a row that says so. */
export const skillFrom = (name: string, text: string): RosterSkill => {
	const fields = parseFrontmatter(text);
	const declared = fields?.get("description");
	return {
		name,
		invocation: `/fabrika:${name}`,
		invocationAxis: fields?.get("disable-model-invocation") === "true" ? "user" : "model",
		description: declared ?? "unknown (frontmatter unreadable)",
		frontmatterReadable: declared !== undefined,
		text,
	};
};

/**
 * Whether `path` is there, with a probe that could not be performed reading as "not there".
 *
 * Only for the resolution rungs, where a rung that cannot answer is meant to fall through to the
 * next one. Everything downstream of a resolved roster keeps `../io/fs.ts`'s discrimination: once a
 * rung has claimed the roster, an unreadable path is UNKNOWN, never empty.
 */
const probe = (path: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const answer = yield* Effect.result(exists(path));
		return Result.isSuccess(answer) && answer.success;
	});

/** The nearest ancestor of `from` for which `marker` resolves, or `null`. */
const nearestAncestorWith = (
	path: Path.Path,
	from: string,
	marker: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		for (const dir of ancestors(path, from)) {
			if (yield* probe(path.join(dir, marker))) return dir;
		}
		return null;
	});

/** The `name` a plugin manifest declares, or `null` when there is no readable one at `root`. */
const declaredName = (
	path: Path.Path,
	root: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const text = yield* Effect.result(readFile(path.join(root, PLUGIN_MANIFEST)));
		if (Result.isFailure(text)) return null;
		const manifest = parseJson(text.success);
		if (!isRecord(manifest)) return null;
		const name = manifest.name;
		return typeof name === "string" && name !== "" ? name : null;
	});

/** Base names in `dir`, sorted, or `[]` when it could not be listed — a rung falling through. */
const listing = (dir: string): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const entries = yield* Effect.result(readDir(dir));
		return Result.isSuccess(entries) ? [...entries.success].sort() : [];
	});

/**
 * The roster inside a plugin root, displayed by the name its manifest declares.
 *
 * The declared name rather than the directory's, because the cache roots this resolves are named
 * for a content hash that changes on every marketplace update — printing one would hand a reader a
 * path that is stale by the next install and machine-local in the meantime.
 */
const rosterIn = (
	path: Path.Path,
	root: string,
	tier: RosterTier,
): Effect.Effect<ResolvedRoster, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const declared = yield* declaredName(path, root);
		return {
			path: path.join(root, "skills"),
			display: `${declared ?? path.basename(root)}/skills`,
			tier,
		};
	});

/**
 * The installed fabrika plugin under Claude Code's plugin cache, or `null`.
 *
 * Layout is `<cache>/<marketplace>/<plugin>/<version>/`, three levels, which is what the harness's
 * own cache sweep walks. A candidate must declare {@link PLUGIN_NAME} and carry a `skills`
 * directory — a half-written cache entry falls through to the repo and checkout rungs rather than
 * claiming the roster and failing the read.
 */
const cachedPluginRoot = (
	path: Path.Path,
	cache: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const held: string[] = [];
		const live: string[] = [];
		for (const marketplace of yield* listing(cache)) {
			const plugins = path.join(cache, marketplace);
			for (const plugin of yield* listing(plugins)) {
				const versions = path.join(plugins, plugin);
				for (const version of yield* listing(versions)) {
					const root = path.join(versions, version);
					if (yield* probe(path.join(root, ORPHANED_MARKER))) continue;
					if ((yield* declaredName(path, root)) !== PLUGIN_NAME) continue;
					if (!(yield* probe(path.join(root, "skills")))) continue;
					((yield* probe(path.join(root, IN_USE_MARKER))) ? held : live).push(root);
				}
			}
		}
		return held[0] ?? live[0] ?? null;
	});

export interface RosterSources {
	/** `--skills-dir`, when the caller passed one. */
	readonly explicit: string | null;
	/** `$CLAUDE_PLUGIN_ROOT` — the harness's own answer, where this invocation was given one. */
	readonly pluginRootEnv: string | null;
	/** Claude Code's plugin cache directory, which the `cache` rung walks. */
	readonly pluginCache: string | null;
	/** The directory of the running module — the `plugin` and `checkout` rungs walk up from here. */
	readonly moduleDir: string;
	/** The invocation directory — the `repo` rung walks up from here for the in-repo checkout. */
	readonly cwd: string;
}

/**
 * The roster path and the tier that served it, before anything is read out of it.
 *
 * `path` is absolute because the reads need it; `display` is what a reader ever sees. An absolute
 * path printed into a session transcript is a machine-local path leak, and the front door prints
 * this one on every cold start.
 */
export interface ResolvedRoster {
	readonly path: string;
	readonly display: string;
	readonly tier: RosterTier;
}

export const resolveRosterPath = (
	sources: RosterSources,
): Effect.Effect<ResolvedRoster | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		if (sources.explicit !== null) {
			return {path: sources.explicit, display: sources.explicit, tier: "explicit" as const};
		}
		// The env rung is the harness's own answer and outranks every probe, but it cannot be the
		// only one: `CLAUDE_PLUGIN_ROOT` is set for plugin hooks and plugin-provided commands and
		// NOT for an ordinary Bash tool call, which is how most of these verbs are invoked (#6448).
		if (
			sources.pluginRootEnv !== null &&
			(yield* probe(path.join(sources.pluginRootEnv, PLUGIN_MANIFEST)))
		) {
			return yield* rosterIn(path, sources.pluginRootEnv, "env");
		}
		// Fires only where the CLI is installed *inside* a plugin tree. Neither shape fabrika ships
		// in packages it that way — the marketplace install is a separate npm package and the dev
		// checkout keeps the CLI at `packages/fabrika-cli/` — so this rung is for a consumer that
		// vendors the CLI into its own plugin, and the ladder below it is what answers at home.
		const pluginRoot = yield* nearestAncestorWith(path, sources.moduleDir, PLUGIN_MANIFEST);
		if (pluginRoot !== null) return yield* rosterIn(path, pluginRoot, "plugin");
		const repoRoot = yield* nearestAncestorWith(path, sources.cwd, IN_REPO_ROSTER);
		if (repoRoot !== null) {
			return {
				path: path.join(repoRoot, IN_REPO_ROSTER),
				display: IN_REPO_ROSTER,
				tier: "repo" as const,
			};
		}
		// The checkout rung walks the same marker up from `moduleDir`, and is the only one that
		// answers in the dev shape: the CLI at `packages/fabrika-cli/` has no plugin manifest above
		// it, so `plugin` cannot fire, and `repo` is rooted at a target repo holding none (#5775).
		const checkoutRoot = yield* nearestAncestorWith(path, sources.moduleDir, IN_REPO_ROSTER);
		if (checkoutRoot !== null) {
			return {
				path: path.join(checkoutRoot, IN_REPO_ROSTER),
				display: IN_REPO_ROSTER,
				tier: "checkout" as const,
			};
		}
		// The rung that answers the marketplace shape: the plugin sits in the harness's cache and the
		// CLI is a global npm package outside it, so nothing on disk connects the two and no walk from
		// `moduleDir` or the cwd can reach the roster (#6448). It sits *below* the two walking rungs
		// on purpose: a phoenix developer has both, and a cache read there would render the published
		// roster over the working tree's, which is the shape #5775 was fixed to serve.
		const cached =
			sources.pluginCache === null ? null : yield* cachedPluginRoot(path, sources.pluginCache);
		return cached === null ? null : yield* rosterIn(path, cached, "cache");
	});

/**
 * Read the roster: resolve it, enumerate every directory holding a `SKILL.md`, and read each one.
 *
 * An unreadable directory or an unreadable `SKILL.md` FAILS rather than shortening the list, which
 * is why `../io/fs.ts`'s `readDir`/`readFile` are typed to fail rather than to return `[]` / `""`.
 */
export const readRoster = (
	sources: RosterSources,
): Effect.Effect<RosterRead, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const resolved = yield* resolveRosterPath(sources);
		if (resolved === null) {
			return {
				_tag: "Failed",
				path: IN_REPO_ROSTER,
				display: IN_REPO_ROSTER,
				reason: "no roster resolved — pass --skills-dir",
			} as const;
		}
		const present = yield* Effect.result(exists(resolved.path));
		if (Result.isFailure(present)) {
			return {
				_tag: "Failed",
				path: resolved.path,
				display: resolved.display,
				reason: present.failure.reason,
			} as const;
		}
		if (!present.success) {
			return resolved.tier === "explicit"
				? ({_tag: "AbsentExplicit", path: resolved.path, display: resolved.display} as const)
				: ({
						_tag: "Failed",
						path: resolved.path,
						display: resolved.display,
						reason: "the resolved roster directory does not exist",
					} as const);
		}
		const entries = yield* Effect.result(readDir(resolved.path));
		if (Result.isFailure(entries)) {
			return {
				_tag: "Failed",
				path: resolved.path,
				display: resolved.display,
				reason: entries.failure.reason,
			} as const;
		}
		const skills: RosterSkill[] = [];
		for (const name of [...entries.success].sort()) {
			const dir = path.join(resolved.path, name);
			// The entry's own type decides, not a probe of the child: a non-directory entry (a
			// `.gitkeep`) makes the child probe raise ENOTDIR, which would read as a failed roster.
			const isDir = yield* Effect.result(isDirectory(dir));
			if (Result.isFailure(isDir)) {
				return {
					_tag: "Failed",
					path: dir,
					display: `${resolved.display}/${name}`,
					reason: isDir.failure.reason,
				} as const;
			}
			if (!isDir.success) continue;
			const file = path.join(dir, "SKILL.md");
			const there = yield* Effect.result(exists(file));
			if (Result.isFailure(there)) {
				return {
					_tag: "Failed",
					path: file,
					display: `${resolved.display}/${name}/SKILL.md`,
					reason: there.failure.reason,
				} as const;
			}
			if (!there.success) continue;
			const text = yield* Effect.result(readFile(file));
			if (Result.isFailure(text)) {
				return {
					_tag: "Failed",
					path: file,
					display: `${resolved.display}/${name}/SKILL.md`,
					reason: text.failure.reason,
				} as const;
			}
			skills.push(skillFrom(name, text.success));
		}
		return {
			_tag: "Resolved",
			path: resolved.path,
			display: resolved.display,
			tier: resolved.tier,
			skills,
			unreadableFrontmatter: skills.filter((s) => !s.frontmatterReadable).length,
		} as const;
	});
