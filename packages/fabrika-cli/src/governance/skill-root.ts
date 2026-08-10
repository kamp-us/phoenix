/**
 * Where this skill's own text lives, resolved out of a commit's tree rather than hardcoded.
 *
 * The pattern carries the **plugin segment** deliberately: a bare `<anything>/skills/governance/` also matches
 * a repo-root `skills/` tree and a symlinked v1 tree, and either would serve the wrong bytes as "this
 * skill's own text". A literal `claude-plugins/fabrika/` fence is the other failure — this skill ships
 * to other repositories, where that path does not exist and the self fence would refuse everywhere.
 *
 * Three outcomes, and the two failures are not the same fact: **zero** matches means there is no self
 * fence to run at this commit, **more than one** means which install is "this skill" is genuinely
 * unknown. Picking one would be a coin flip the caller cannot see.
 */

/** The tracked path that identifies an install: `<anything>/fabrika/skills/governance/SKILL.md`. */
const SKILL_FILE = /(^|\/)fabrika\/skills\/governance\/SKILL\.md$/;

export type SkillRoots =
	| {readonly _tag: "One"; readonly root: string}
	| {readonly _tag: "None"}
	| {readonly _tag: "Many"; readonly candidates: ReadonlyArray<string>};

/** Every install's root directory, trailing slash included, sorted so two runs answer alike. */
export const skillRootsIn = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
	[
		...new Set(
			paths.filter((path) => SKILL_FILE.test(path)).map((path) => path.replace(/SKILL\.md$/, "")),
		),
	].sort();

export const resolveSkillRoots = (paths: ReadonlyArray<string>): SkillRoots => {
	const roots = skillRootsIn(paths);
	const only = roots[0];
	if (only === undefined) return {_tag: "None"};
	return roots.length === 1 ? {_tag: "One", root: only} : {_tag: "Many", candidates: roots};
};

/** Whether `path` lies inside the resolved root — the `--path` fence `governance base` applies. */
export const insideRoot = (root: string, path: string): boolean =>
	path.startsWith(root) && path !== root;
