/**
 * `main-sync` dep-refresh pure core — decide, from the paths a fast-forward pulled,
 * whether the installed `node_modules` is now stale and must be re-installed, and guard
 * the pnpm version that install runs under. IO-free and total; the corepack/pnpm/git
 * boundary (diff / --version / install) lives in `command.ts`. See #3498.
 *
 * The forcing hazard: a ff that advances `patches/**` or `pnpm-lock.yaml` moves the
 * SOURCE patch/lockfile but never the installed `.pnpm/…/patched` copy the runtime
 * executes — so a re-booted crew silently runs the PRE-merge patched dep (a merged fix
 * reads as "still broken"). The fix re-installs with the REPO-PINNED pnpm on any such ff,
 * or FAILS LOUD — never a bare-PATH pnpm (whose wrong major silently leaves a stale dir).
 */

/** A semver-ish pnpm version reduced to what the guard needs: the full string + its major. */
export interface PnpmVersion {
	readonly version: string;
	readonly major: number;
}

/**
 * A changed path forces a dep re-install iff it is the lockfile or lives under `patches/`.
 * Both are inputs the installed `node_modules` is derived from, so a ff that moves either
 * leaves the install stale until a re-install (#3498).
 */
export const pathForcesDepRefresh = (path: string): boolean =>
	path === "pnpm-lock.yaml" || path.startsWith("patches/");

/** The subset of `paths` that forces a dep refresh — the reportable "why" behind the decision. */
export const depPathsForcingRefresh = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
	paths.filter(pathForcesDepRefresh);

/** True iff any pulled path forces a dep refresh. */
export const changedPathsForceDepRefresh = (paths: ReadonlyArray<string>): boolean =>
	paths.some(pathForcesDepRefresh);

// A version tail may carry a corepack integrity hash (`10.27.0+sha512.…`) or a prerelease
// (`10.27.0-rc.1`); the major/minor/patch triple is all the guard reads, so absorb the tail.
const SEMVER_HEAD = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/**
 * Parse the root `packageManager` pin (`pnpm@10.27.0`) to the required pnpm version. Returns
 * `null` when the field is absent, names a different package manager, or is malformed — the
 * guard treats a `null` required version as unresolved (fail-closed), never a pass.
 */
export const parsePackageManagerPnpm = (packageManager: string | undefined): PnpmVersion | null => {
	if (!packageManager) return null;
	const m = packageManager.trim().match(/^pnpm@(\d+\.\d+\.\d+(?:[-+].*)?)$/);
	if (!m) return null;
	return parsePnpmVersionOutput(m[1] ?? "");
};

/**
 * Parse `pnpm --version` stdout (a bare semver line) to a `PnpmVersion`. Returns `null` on
 * empty/non-semver output — i.e. corepack/pnpm didn't resolve — which the guard fail-closes.
 */
export const parsePnpmVersionOutput = (output: string): PnpmVersion | null => {
	const first = output.trim().split(/\s+/)[0] ?? "";
	const m = first.match(SEMVER_HEAD);
	if (!m) return null;
	return {version: `${m[1]}.${m[2]}.${m[3]}`, major: Number(m[1])};
};

/**
 * The pnpm-version guard outcome (candidate 3 of #3498, folded into the install path). Only
 * `ok` authorizes the install; every other case is a fail-closed refusal with the reason a
 * LOUD message reports — a crew-affecting install NEVER proceeds under an unknown/wrong major.
 */
export type PnpmGuardResult =
	// The pinned pnpm resolved and its major matches the repo requirement — install may run.
	| {readonly ok: true; readonly resolved: PnpmVersion}
	// The `packageManager` pin was absent/unparseable — the required version is unknown.
	| {readonly ok: false; readonly reason: "unresolved-required"}
	// `corepack pnpm --version` didn't resolve (corepack absent / errored) — never fall back to
	// a bare-PATH pnpm, which is the wrong-major hazard this whole fix exists to close.
	| {readonly ok: false; readonly reason: "unresolved-pnpm"}
	// Resolved pnpm's major differs from the repo requirement — a `pnpm@8` install silently
	// leaves a stale patched dir (#3498), so fail closed instead of installing under it.
	| {
			readonly ok: false;
			readonly reason: "major-mismatch";
			readonly required: PnpmVersion;
			readonly resolved: PnpmVersion;
	  };

/**
 * Decide the pnpm-version guard. Total over the two nullable inputs (required = the parsed
 * `packageManager` pin, resolved = the parsed `corepack pnpm --version`): a `null` on either
 * side is a fail-closed refusal, and only an equal-major pair authorizes the install.
 */
export const decidePnpmVersionGuard = (
	required: PnpmVersion | null,
	resolved: PnpmVersion | null,
): PnpmGuardResult => {
	if (required === null) return {ok: false, reason: "unresolved-required"};
	if (resolved === null) return {ok: false, reason: "unresolved-pnpm"};
	if (resolved.major !== required.major) {
		return {ok: false, reason: "major-mismatch", required, resolved};
	}
	return {ok: true, resolved};
};
