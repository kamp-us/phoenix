/**
 * `@kampus/worktree-guard` path-resolution core — the pure, IO-free decision an
 * `isolation:worktree` subagent's `PreToolUse` hook makes so a Read/Edit/Write
 * call lands in the agent's WORKTREE, not the main checkout (issue #741).
 *
 * The hazard (documented in MEMORY "Worktree agent cwd reset"): a worktree
 * subagent's Bash cwd resets to the MAIN checkout between calls, so a relative
 * path — or an absolute path the agent wrote against the main checkout — targets
 * the primary tree and mis-edits / mis-branches it. The fix is a path rewrite:
 * given the agent's `$WORKTREE_ROOT` and a file-tool's candidate path, return the
 * worktree-pinned path when the file-tool would otherwise hit the main checkout.
 *
 * The non-obvious part is deriving the MAIN-CHECKOUT prefix from `$WORKTREE_ROOT`
 * alone, with no extra config: an agent worktree lives at
 * `<main>/.claude/worktrees/<id>`, so the main checkout is the path left of the
 * `/.claude/worktrees/` segment. A `$WORKTREE_ROOT` NOT under that layout (a
 * bespoke worktree dir) yields no derivable main prefix, so the rewrite is a
 * no-op — fail-open, never invent a target.
 */

export type PathDecision =
	| {readonly kind: "allow"}
	| {readonly kind: "rewrite"; readonly absolutePath: string; readonly reason: string}
	| {readonly kind: "block"; readonly corrected: string; readonly reason: string};

const WORKTREE_SEGMENT = "/.claude/worktrees/";

const normalize = (p: string): string => p.replace(/\\/g, "/");

const stripTrailingSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

const isAbsolute = (p: string): boolean => p.startsWith("/");

/**
 * The MAIN checkout this worktree branched from, derived from the worktree layout
 * `<main>/.claude/worktrees/<id>` — the segment left of `/.claude/worktrees/`.
 * `null` when `$WORKTREE_ROOT` is empty or not under that layout (no rewrite then).
 */
export const mainCheckoutPrefix = (worktreeRoot: string): string | null => {
	if (!worktreeRoot) return null;
	const wt = stripTrailingSlash(normalize(worktreeRoot));
	const idx = wt.indexOf(WORKTREE_SEGMENT);
	if (idx <= 0) return null;
	return wt.slice(0, idx);
};

/** Join a directory and a (possibly relative) path into a normalized absolute path. */
const resolveAgainst = (dir: string, path: string): string => {
	const segments = `${stripTrailingSlash(dir)}/${path}`.split("/");
	const out: string[] = [];
	for (const seg of segments) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			out.pop();
			continue;
		}
		out.push(seg);
	}
	return `/${out.join("/")}`;
};

/**
 * Decide how a file-tool's `candidatePath` should resolve for a worktree subagent.
 *
 * - No `$WORKTREE_ROOT`, or a root not under the worktree layout → **allow** (this
 *   is not a managed worktree agent; never invent a target).
 * - A **relative** path → resolve it against `$WORKTREE_ROOT` (NOT the reset cwd)
 *   and **rewrite** to that absolute path — this is the cwd-reset fix.
 * - An **absolute** path already inside the worktree → **allow** (correct already).
 * - An **absolute** path under the MAIN checkout that has an identically-named copy
 *   in the worktree → **rewrite** to the worktree copy (`existsInWorktree` true).
 * - An **absolute** path under the MAIN checkout with NO worktree copy → **block**
 *   with the corrected worktree-relative absolute path (the agent must decide; we
 *   never silently create a file in the wrong place).
 * - Any other absolute path (outside both trees — /tmp, etc.) → **allow**.
 */
export const resolvePath = (args: {
	readonly worktreeRoot: string;
	readonly cwd: string;
	readonly candidatePath: string;
	/** Whether the same relative path exists as a real file under the worktree. */
	readonly existsInWorktree: (worktreeAbsolutePath: string) => boolean;
}): PathDecision => {
	const {worktreeRoot, cwd, candidatePath, existsInWorktree} = args;
	if (!candidatePath) return {kind: "allow"};

	const wtRoot =
		mainCheckoutPrefix(worktreeRoot) === null ? null : stripTrailingSlash(normalize(worktreeRoot));
	const mainRoot = mainCheckoutPrefix(worktreeRoot);
	if (wtRoot === null || mainRoot === null) return {kind: "allow"};

	const candidate = normalize(candidatePath);

	if (!isAbsolute(candidate)) {
		const abs = resolveAgainst(worktreeRoot, candidate);
		return {
			kind: "rewrite",
			absolutePath: abs,
			reason: `relative path resolved against $WORKTREE_ROOT (cwd ${cwd} may be the main checkout)`,
		};
	}

	const abs = resolveAgainst("/", candidate);

	if (abs === wtRoot || abs.startsWith(`${wtRoot}/`)) return {kind: "allow"};

	if (abs === mainRoot || abs.startsWith(`${mainRoot}/`)) {
		// An absolute main-checkout path that is ITSELF the worktree segment or below
		// is already inside a worktree (handled above); here it's the main tree proper.
		const rel = abs.slice(mainRoot.length).replace(/^\/+/, "");
		const worktreeCopy = rel === "" ? wtRoot : `${wtRoot}/${rel}`;
		if (existsInWorktree(worktreeCopy)) {
			return {
				kind: "rewrite",
				absolutePath: worktreeCopy,
				reason: "path under the main checkout has an identically-named copy in the worktree",
			};
		}
		return {
			kind: "block",
			corrected: worktreeCopy,
			reason:
				"path targets the main checkout with no worktree copy; use the corrected worktree path",
		};
	}

	return {kind: "allow"};
};
