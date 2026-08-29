/**
 * The decisions behind `hook worktree-create`, with no subprocess and no fd in sight.
 *
 * `WorktreeCreate` is a **provider** hook: the harness hands it a slug and expects the worktree to
 * exist and its path on stdout when the hook exits 0 (`../../../../claude-plugins/fabrika/docs/hook-surface.md`).
 * So the verb beside this file runs two git commands, and everything it has to get *right* before it
 * runs them — where the tree goes, what the child's `PATH` must carry — is decided here, where a
 * unit test can drive it.
 *
 * Two facts this module encodes are captured, not assumed (ADR 0180): the payload carries `cwd` and
 * `name` and **no** `worktree_path` or `base_ref`, and the path is therefore *constructed* rather
 * than read. `__fixtures__/worktree-create.payload.golden.json` is the capture.
 */

/** Where a hook-provisioned worktree goes, and the repo the git commands run in. */
export interface WorktreePlan {
	/** The repository root the payload named. Every git command runs here, not in `process.cwd()`. */
	readonly repoRoot: string;
	/** The harness's suggested slug, verbatim. */
	readonly name: string;
	/** `<repoRoot>/.claude/worktrees/<name>` — the layout the harness's own default path uses. */
	readonly worktreePath: string;
}

export type PlanRead =
	| {readonly _tag: "Plan"; readonly plan: WorktreePlan}
	| {readonly _tag: "Unplannable"; readonly reason: string};

/**
 * A slug that cannot escape `<repoRoot>/.claude/worktrees/`.
 *
 * The harness validates the path it gets *back* — it rejects dot segments — but a hook that built a
 * traversing path has already run `git worktree add` at it by then, so the refusal must happen
 * before the mutation, not after.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The one place the worktree path is composed. Both the verb and its test read it from here. */
export const worktreePathFor = (repoRoot: string, name: string): string =>
	`${repoRoot}/.claude/worktrees/${name}`;

/**
 * Turn a captured `WorktreeCreate` payload into the plan, or say why there is none.
 *
 * Every arm is fail-closed on purpose: the verb's caller is the harness, a refusal there blocks the
 * spawn, and a spawn that never happens is strictly better than one landing in a tree this hook
 * could not fully build (ADR 0092).
 */
export const planWorktree = (payload: Record<string, unknown>): PlanRead => {
	const repoRoot = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
	const name = typeof payload.name === "string" ? payload.name.trim() : "";

	if (repoRoot === "") return {_tag: "Unplannable", reason: "the payload carries no `cwd`"};
	if (!repoRoot.startsWith("/")) {
		return {_tag: "Unplannable", reason: `\`cwd\` is not an absolute path: ${repoRoot}`};
	}
	if (name === "") return {_tag: "Unplannable", reason: "the payload carries no `name`"};
	if (!SAFE_NAME.test(name)) {
		return {
			_tag: "Unplannable",
			reason: `\`name\` is not a plain worktree slug and could escape the worktree root: ${name}`,
		};
	}

	return {_tag: "Plan", plan: {repoRoot, name, worktreePath: worktreePathFor(repoRoot, name)}};
};

/**
 * The standard toolchain locations, prepended to whatever `PATH` the hook inherited.
 *
 * This is the whole reason provisioning works at all. `git worktree add` fires lefthook's
 * `post-checkout` `bootstrap-deps`, and that hook **clean-SKIPs at exit 0** when it finds no
 * corepack, no pinned pnpm and no npm on `PATH` (ADR 0109 §3) — which is precisely the harness's
 * PATH-stripped `git worktree add` exec env (#787–#789). A skip there is silent, so the tree is
 * created, adopted, and useless. Prepending the OS-standard bin dirs is what lets the install run.
 *
 * OS/standard dirs only, never a per-machine volta/fnm shim — ADR 0109's prohibition. The inherited
 * `PATH` is kept **last** rather than dropped, so a machine whose toolchain lives somewhere else
 * still resolves it.
 */
const STANDARD_BIN_DIRS: ReadonlyArray<string> = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/bin",
	"/usr/bin",
];

export const toolchainPath = (inherited: string | undefined, home: string | undefined): string => {
	const localBin = home === undefined || home.trim() === "" ? [] : [`${home}/.local/bin`];
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const dir of [
		...STANDARD_BIN_DIRS,
		...localBin,
		...(inherited ?? "").split(":").filter((d) => d !== ""),
	]) {
		if (seen.has(dir)) continue;
		seen.add(dir);
		ordered.push(dir);
	}
	return ordered.join(":");
};

/**
 * The environment the two git children run under.
 *
 * Nothing is inherited implicitly (`execRecord` sets `extendEnv: false`), so what is not here does
 * not reach `bootstrap-deps`. `HOME` carries the pnpm/corepack store — an install without it
 * re-downloads the world or fails outright — and `PATH` is the composed one above.
 */
export const childEnv = (
	source: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
	const env: Record<string, string> = {PATH: toolchainPath(source.PATH, source.HOME)};
	for (const key of ["HOME", "LANG", "LC_ALL", "TMPDIR", "COREPACK_HOME", "XDG_CACHE_HOME"]) {
		const value = source[key];
		if (value !== undefined && value !== "") env[key] = value;
	}
	return env;
};
