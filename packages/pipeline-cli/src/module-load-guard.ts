/**
 * Legible failure for the in-repo-first bin path when a workspace dep isn't linked (#1798).
 *
 * `bin.ts` reaches its tool graph through static ESM imports, so an unlinked
 * `catalog:` dep (e.g. `yaml`, before `pnpm install` has settled on a fresh or
 * partial checkout) surfaces as a raw `ERR_MODULE_NOT_FOUND` at module-load time
 * — before any of the bin's own code runs, with no hint that the fix is an
 * install. This module is the pure classifier + message the bin's dynamic-import
 * bootstrap uses to turn that opaque throw into an actionable remediation.
 *
 * It scopes deliberately to a **bare-specifier** miss (`Cannot find package '<name>'`
 * — an unlinked dependency), NOT a missing relative source file (`Cannot find
 * module '/abs/path'`), which is a real code bug we must not mask.
 */

/** The pnpm filter that links this package's own deps in isolation. */
const FILTER_INSTALL = "pnpm --filter @kampus/pipeline-cli install";

/**
 * True iff `err` is a Node `ERR_MODULE_NOT_FOUND` for an **unlinked package**
 * (a bare specifier), the install-timing case — not a missing relative file.
 *
 * Node distinguishes the two in the message: a bare specifier miss reads
 * `Cannot find package '<name>' imported from …`, a relative miss reads
 * `Cannot find module '<abs-path>' imported from …`. We remediate only the
 * former so a genuinely-missing source file still fails as the real bug it is.
 */
export const isUnlinkedDependencyError = (err: unknown): err is Error & {code: string} => {
	if (typeof err !== "object" || err === null) return false;
	const code = (err as {code?: unknown}).code;
	const message = (err as {message?: unknown}).message;
	return (
		code === "ERR_MODULE_NOT_FOUND" &&
		typeof message === "string" &&
		message.includes("Cannot find package ")
	);
};

/**
 * Extract the unlinked package name from a Node `ERR_MODULE_NOT_FOUND` message,
 * or `null` if it doesn't match the `Cannot find package '<name>'` shape.
 */
export const unlinkedPackageName = (message: string): string | null => {
	const m = message.match(/Cannot find package '([^']+)'/);
	return m ? (m[1] ?? null) : null;
};

/**
 * The actionable remediation printed in place of the raw stack when a workspace
 * dep isn't linked yet. Covers the general missing-dependency case, not just
 * `yaml` — the message names whichever package Node reported (if resolvable).
 */
export const remediationMessage = (err: Error & {code: string}): string => {
	const pkg = unlinkedPackageName(err.message);
	const missing = pkg ? `dependency \`${pkg}\`` : "a dependency";
	return [
		`pipeline-cli: ${missing} isn't linked yet — its \`catalog:\` deps haven't been installed.`,
		"",
		"Run one of these from the repo root, then retry:",
		"  pnpm install                              # full workspace install",
		`  ${FILTER_INSTALL}   # just this package`,
	].join("\n");
};
