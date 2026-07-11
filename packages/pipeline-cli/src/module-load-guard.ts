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

/** Opt-out env var: set it to disable the self-heal and drop straight to the #1798 fallback. */
export const NO_SELF_HEAL_ENV = "PIPELINE_CLI_NO_SELF_HEAL";

/**
 * True unless the caller opted out via `PIPELINE_CLI_NO_SELF_HEAL`. The auto-install is
 * desirable on the primary checkout (where `main-sync` must be runnable with zero manual
 * install), but an environment that installs deps itself and forbids an implicit one — a
 * frozen-lockfile CI runner, say — sets the var to skip the heal and fail fast instead.
 * A falsey value (`""`, `"0"`, `"false"`) reads as unset so `VAR=0` doesn't accidentally arm it.
 */
export const shouldSelfHeal = (env: {[NO_SELF_HEAL_ENV]?: string}): boolean => {
	const v = env[NO_SELF_HEAL_ENV];
	return v === undefined || v === "" || v === "0" || v === "false";
};

export interface SelfHealOptions {
	/** Load the tool graph — the bin's dynamic `import("./run.ts")`. */
	load: () => Promise<unknown>;
	/** The one-shot workspace install run to link the missing dep. */
	install: () => Promise<void>;
	/** Off ⇒ skip the heal and rethrow the unlinked-dep error to the #1798 fallback. Default on. */
	selfHealEnabled?: boolean;
	/** Observability hook fired just before the single install attempt (the healed package name). */
	onHealAttempt?: (pkg: string | null) => void;
}

/**
 * Bounded, idempotent self-heal for the unlinked-workspace-dep condition (#2459).
 *
 * `main-sync` (and every pipeline-cli tool) runs from source as `node src/bin.ts …`, so a
 * `pipeline-cli` workspace-dep-graph change (PR #2447 switched `@kampus/ci-required` to a
 * `workspace:*` import) leaves the primary checkout's `node_modules` stale and the dynamic
 * `import("./run.ts")` throws the unlinked-dep `ERR_MODULE_NOT_FOUND` `isUnlinkedDependencyError`
 * classifies. Rather than dead-ending at the legible remediation, we first try to heal the exact
 * condition: run one workspace install, then retry the load. The install runs **at most once** per
 * process (bounded — never a retry loop) and **only** for the classifier-accepted unlinked-dep case,
 * so a genuine missing-source-file miss (or any unrelated throw) propagates untouched and still fails
 * as the real bug it is. If the single retry still can't link the dep, that throw propagates too and
 * the caller falls back to the #1798 fail-fast remediation — the legible message is preserved as the
 * last resort, not replaced.
 */
export const loadWithSelfHeal = async ({
	load,
	install,
	selfHealEnabled = true,
	onHealAttempt,
}: SelfHealOptions): Promise<void> => {
	try {
		await load();
		return;
	} catch (err) {
		if (!selfHealEnabled || !isUnlinkedDependencyError(err)) throw err;
		onHealAttempt?.(unlinkedPackageName(err.message));
		await install();
		await load();
	}
};
