/**
 * Where the skill roster lives, and what one `SKILL.md` says about itself.
 *
 * **The roster is the plugin's, not the target repo's.** fabrika installs into repos that are not
 * phoenix (#4776), so defaulting to a repo-relative path would make `status menu` and
 * `status config` empty on precisely the fresh repo this skill onboards. Resolution runs three
 * tiers and prints which one served, so a caller can re-run the read instead of adopting the render.
 *
 * **A roster that resolves and holds zero skills is a fact, not a failure**; a roster that could not
 * be read, or one `SKILL.md` inside it that could not be read, is UNKNOWN. A partial roster is not a
 * roster — the false-absence class of #4105 and #4163.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import {ancestors} from "../delegate/root.ts";
import {exists, isDirectory, readDir, readFile} from "../io/fs.ts";

/** Which of the three tiers served the roster. Printed, never assumed. */
export type RosterTier = "explicit" | "plugin" | "repo";

/** Who can reach a skill — the one routing fact a reader cannot infer from a description. */
export type InvocationAxis = "model" | "user";

/** The plugin-manifest directory that marks an installed fabrika plugin root. */
export const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";

/** The in-repo development location of the roster, relative to the repository root. */
export const IN_REPO_ROSTER = "claude-plugins/fabrika/skills";

export interface RosterSkill {
	readonly name: string;
	readonly invocation: string;
	readonly invocationAxis: InvocationAxis;
	readonly description: string;
	/** Whether the frontmatter parsed. A `false` row still ships — a dropped row is a false absence. */
	readonly frontmatterReadable: boolean;
	/** The whole `SKILL.md`, so `status config` parses its declarations without a second read. */
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

/** The nearest ancestor of `from` for which `marker` resolves, or `null`. */
const nearestAncestorWith = (
	path: Path.Path,
	from: string,
	marker: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		for (const dir of ancestors(path, from)) {
			const probe = yield* Effect.result(exists(path.join(dir, marker)));
			if (Result.isSuccess(probe) && probe.success) return dir;
		}
		return null;
	});

export interface RosterSources {
	/** `--skills-dir`, when the caller passed one. */
	readonly explicit: string | null;
	/** The directory of the running module — tier 2 walks up from here. */
	readonly moduleDir: string;
	/** The invocation directory — tier 3 walks up from here for the in-repo checkout. */
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
		const pluginRoot = yield* nearestAncestorWith(path, sources.moduleDir, PLUGIN_MANIFEST);
		if (pluginRoot !== null) {
			return {
				path: path.join(pluginRoot, "skills"),
				display: `${path.basename(pluginRoot)}/skills`,
				tier: "plugin" as const,
			};
		}
		const repoRoot = yield* nearestAncestorWith(path, sources.cwd, IN_REPO_ROSTER);
		return repoRoot === null
			? null
			: {
					path: path.join(repoRoot, IN_REPO_ROSTER),
					display: IN_REPO_ROSTER,
					tier: "repo" as const,
				};
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
