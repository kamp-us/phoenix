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

import {join} from "node:path";

/** The pnpm filter that links this package's own deps in isolation. */
const FILTER_INSTALL = "pnpm --filter @kampus/pipeline-cli install";

/**
 * The argv the self-heal install runs pnpm with. `--config.confirm-modules-purge=true`
 * keeps pnpm's destructive-purge guard ARMED, so a self-heal that would otherwise "remove
 * and reinstall node_modules from scratch" instead **aborts** under a non-TTY stdin
 * (`ABORTED_REMOVE_MODULES_DIR_NO_TTY`) rather than wiping the modules farm (#3504).
 *
 * Grounded in pnpm 10.27.0 (`purgeModulesDirsOfImporters` in its `dist/pnpm.mjs`), NOT
 * intuition: the purge path is `if (confirmModulesPurge ?? true) { if (!stdin.isTTY) throw
 * ABORTED_REMOVE_MODULES_DIR_NO_TTY; … }` — so `true` + no-TTY THROWS (safe), while the
 * value the original report guessed, `=false`, takes the `else` branch and purges
 * **silently**. Passing `=false` would be the exact opposite of the fix; we pass `=true`
 * and the bin runs pnpm with a non-TTY stdin so the abort is guaranteed to fire.
 */
export const SELF_HEAL_INSTALL_ARGS: readonly string[] = [
	"install",
	"--config.confirm-modules-purge=true",
];

/**
 * The refusal message when the self-heal install is asked to run over a symlinked
 * repo-root `node_modules`. Named separately so the bin and the test share one string.
 */
export const selfHealSymlinkRefusal = (nodeModulesPath: string): string =>
	[
		`pipeline-cli self-heal: refusing to \`pnpm install\` — \`${nodeModulesPath}\` is a symlink.`,
		"A destructive install here would follow the link and purge the symlink target's",
		"node_modules (the shared primary checkout, when a worktree lane symlinks into it) —",
		"the primary-checkout-corruption class (#2143/#2144/#2270) via the hook+pnpm path (#3504).",
		"Provision a real per-worktree node_modules instead of symlinking into the primary.",
	].join("\n");

/** lstat shape the guard needs — just the symlink predicate; `null` when the path is absent. */
export interface LstatLike {
	isSymbolicLink(): boolean;
}

/**
 * Fail-closed guard run immediately before the self-heal `pnpm install`: throw iff the
 * repo-root `node_modules` is a **symlink**. That is the #3504 corruption vector — a
 * worktree lane symlinks its `node_modules` into the shared primary checkout, and a
 * destructive install follows the link and wipes the primary's farm. Version-robust (it
 * does not rely on any particular pnpm's purge-confirmation behavior): a symlinked
 * modules dir is never a path a mutating install may follow, on any pnpm. A real
 * directory (the normal primary/`main-sync` self-heal) passes untouched.
 */
export const assertSelfHealInstallSafe = (
	rootDir: string,
	lstat: (path: string) => LstatLike | null,
): void => {
	const nodeModulesPath = join(rootDir, "node_modules");
	if (lstat(nodeModulesPath)?.isSymbolicLink()) {
		throw new Error(selfHealSymlinkRefusal(nodeModulesPath));
	}
};

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
 * `pipeline-cli` workspace-dep-graph change (e.g. PR #2447, which switched the then-standalone
 * `ci-required` package to a `workspace:*` import before it was inlined into pipeline-cli, #3802)
 * leaves the primary checkout's `node_modules` stale and the dynamic
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
