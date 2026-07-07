/**
 * `findRootDir` — the shared repo-root upward-walk used by every tool that must
 * scan the whole repo regardless of the cwd it was invoked from.
 *
 * A tool run under `pnpm --filter <pkg> …` starts with cwd at the *package* dir,
 * not the repo root; walking up to the first ancestor bearing a workspace/VCS
 * marker is what lets the scan cover the whole tree instead of just that package
 * (the decisions-index #447 fix). It lived in the now-removed `doc-links` tool
 * (the first tool to need it); relocated here as a cross-tool primitive (#2308).
 */

/**
 * Walk up from `start` for the first ancestor for which `hasMarker(dir)` holds,
 * returning that directory; or `null` if the filesystem root is reached without a
 * hit. Pure (the IO — "does this dir carry a marker?" — is the injected predicate),
 * so the upward-walk logic is unit-testable without touching disk. `dirname` is the
 * only path op: `dirname("/") === "/"` is the fixpoint that ends the walk.
 */
export const findRootDir = (
	start: string,
	hasMarker: (dir: string) => boolean,
	dirname: (p: string) => string,
): string | null => {
	let dir = start;
	for (;;) {
		if (hasMarker(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
};
