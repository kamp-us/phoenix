/**
 * `main-sync` dep-refresh pure core — decide, from the paths a fast-forward pulled,
 * whether the installed `node_modules` is now stale and must be re-installed, and guard
 * the pnpm version that install runs under. IO-free and total; the corepack/pnpm/git
 * boundary (diff / --version / install) lives in `command.ts`. See #3498.
 *
 * The forcing hazard: a ff that advances `patches/**` or `pnpm-lock.yaml` moves the
 * SOURCE patch/lockfile but never the installed `.pnpm/…/patched` copy the runtime
 * executes — so a re-booted session silently runs the PRE-merge patched dep (a merged fix
 * reads as "still broken"). The fix re-installs with the REPO-PINNED pnpm on any such ff,
 * or FAILS LOUD — never an unverified PATH pnpm (whose wrong major silently leaves a stale dir).
 *
 * The pin resolves through an ORDERED strategy (#4063): a PATH pnpm whose full version is
 * EXACTLY the pin, else corepack, else fail closed. Exact equality is strictly stronger than
 * the major-only comparison the corepack path already trusts, so admitting it cannot reopen
 * the hazard above — while a corepack-less machine (volta ships none) stops dead-ending in a
 * refusal whose printed remedy was itself un-runnable there.
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
 * LOUD message reports — a repo-wide install NEVER proceeds under an unknown/wrong major.
 */
export type PnpmGuardResult =
	// The pinned pnpm resolved and its major matches the repo requirement — install may run.
	| {readonly ok: true; readonly resolved: PnpmVersion}
	// The `packageManager` pin was absent/unparseable — the required version is unknown.
	| {readonly ok: false; readonly reason: "unresolved-required"}
	// `corepack pnpm --version` didn't resolve (corepack absent / errored). The only sanctioned
	// PATH pnpm is an EXACT pin match, decided upstream by `classifyPathPnpm` — never here.
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
 * Decide the pnpm-version guard for the COREPACK leg. Total over the two nullable inputs
 * (required = the parsed `packageManager` pin, resolved = the parsed `corepack pnpm --version`):
 * a `null` on either side is a fail-closed refusal, and only an equal-major pair authorizes the
 * install. Major-only is right here because corepack was asked for `pnpm@<pin>` by name; the PATH
 * leg, which asks for nothing, is held to exact equality instead (`classifyPathPnpm`).
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

/**
 * Why a `pnpm --version` probe yielded no version. Both values mean the SAME thing to the
 * decision — the version is UNKNOWN, not wrong — and that distinction is the point: a probe
 * that could not execute (missing binary, stripped PATH, non-zero exit, timeout) must never be
 * reported as "the pnpm on this machine is the wrong version". Only a probe that actually ran
 * and produced a version may conclude that.
 */
export type PnpmProbeFailure = "probe-failed" | "unparseable-output";

/** The outcome of one IO probe of a pnpm binary, as handed to the pure decision. */
export type PnpmProbeResult =
	| {readonly ran: true; readonly version: PnpmVersion}
	| {readonly ran: false; readonly cause: PnpmProbeFailure};

/**
 * The three outcomes of checking the PATH `pnpm` against the pin — deliberately three, not two.
 * `version-mismatch` is a VERIFIED fact about this machine (a pnpm ran and it is not the pin);
 * `undetermined` is the absence of any fact. They demand different remedies, so they are never
 * collapsed into one refusal (#4063).
 */
export type PathPnpmVerdict =
	| {readonly kind: "exact-match"; readonly version: PnpmVersion}
	| {
			readonly kind: "version-mismatch";
			readonly required: PnpmVersion;
			readonly found: PnpmVersion;
	  }
	| {readonly kind: "undetermined"; readonly cause: PnpmProbeFailure | "no-required-version"};

/**
 * Classify a PATH `pnpm --version` probe against the pin. Acceptance is FULL-STRING equality,
 * never the major-only comparison the corepack leg uses: the PATH pnpm is authorized only when
 * it is provably the pinned binary.
 */
export const classifyPathPnpm = (
	required: PnpmVersion | null,
	probe: PnpmProbeResult,
): PathPnpmVerdict => {
	if (required === null) return {kind: "undetermined", cause: "no-required-version"};
	if (!probe.ran) return {kind: "undetermined", cause: probe.cause};
	if (probe.version.version !== required.version) {
		return {kind: "version-mismatch", required, found: probe.version};
	}
	return {kind: "exact-match", version: probe.version};
};

/** Which strategy produced the pnpm the install runs under — reported so a transcript names it. */
export type PnpmResolver = "path" | "corepack";

/**
 * The ordered resolution's outcome. A refusal carries BOTH legs' reasons, so the message can say
 * what is actually true of the machine rather than blaming whichever leg happened to run last.
 */
export type PnpmResolution =
	| {readonly ok: true; readonly resolver: PnpmResolver; readonly resolved: PnpmVersion}
	| {
			readonly ok: false;
			/** The pin itself, `null` only when it was the pin that failed to parse. */
			readonly required: PnpmVersion | null;
			// An exact match authorizes the install, so it can never be a refusal's reason.
			readonly path: Exclude<PathPnpmVerdict, {kind: "exact-match"}>;
			readonly corepack: Extract<PnpmGuardResult, {ok: false}>;
	  };

/**
 * Resolve the pnpm the install runs under: PATH-exact, else corepack, else fail closed.
 *
 * `probeCorepack` is a thunk so the corepack probe is NOT run when PATH already matched (and can
 * never be run without a pin to ask for); the IO itself stays at the `command.ts` boundary, and
 * this stays a total decision a unit test can drive.
 */
export const decidePnpmResolution = (
	required: PnpmVersion | null,
	pathProbe: PnpmProbeResult,
	probeCorepack: (required: PnpmVersion) => PnpmProbeResult,
): PnpmResolution => {
	const path = classifyPathPnpm(required, pathProbe);
	if (path.kind === "exact-match") return {ok: true, resolver: "path", resolved: path.version};
	if (required === null) {
		return {ok: false, required, path, corepack: {ok: false, reason: "unresolved-required"}};
	}

	const probe = probeCorepack(required);
	const guard = decidePnpmVersionGuard(required, probe.ran ? probe.version : null);
	if (guard.ok) return {ok: true, resolver: "corepack", resolved: guard.resolved};
	return {ok: false, required, path, corepack: guard};
};

/** The `detail` + `remedy` halves of the fail-closed message, split so each is asserted directly. */
export interface PnpmResolutionFailureMessage {
	readonly detail: string;
	readonly remedy: string;
}

const describePathLeg = (path: Exclude<PathPnpmVerdict, {kind: "exact-match"}>): string => {
	switch (path.kind) {
		case "version-mismatch":
			return `PATH \`pnpm\` ran and reported ${path.found.version}, which is NOT the pinned ${path.required.version} — a non-exact PATH pnpm is never used for the install`;
		case "undetermined":
			return path.cause === "no-required-version"
				? "the PATH pnpm was not checked (no pin to check it against)"
				: "PATH `pnpm` could not be probed (absent, not on PATH, or the probe errored), so its version is UNKNOWN — not wrong";
	}
};

const describeCorepackLeg = (corepack: Extract<PnpmGuardResult, {ok: false}>): string => {
	switch (corepack.reason) {
		case "unresolved-required":
			return "the root package.json `packageManager` pin is absent or unparseable — cannot determine the required pnpm version";
		case "unresolved-pnpm":
			return "corepack could not resolve the pinned pnpm either (corepack absent or errored)";
		case "major-mismatch":
			return `corepack resolved pnpm ${corepack.resolved.version} (major ${corepack.resolved.major}), which does NOT match the repo-required major ${corepack.required.major} (${corepack.required.version})`;
	}
};

/**
 * Build the fail-closed message. The remedy is chosen from what the machine has PROVEN it has, so
 * it is never `corepack …` on a machine whose corepack is the thing that just failed (#4063) — a
 * printed recovery the operator cannot run is worse than none.
 */
export const describePnpmResolutionFailure = (
	failure: Extract<PnpmResolution, {ok: false}>,
): PnpmResolutionFailureMessage => {
	const {path, corepack} = failure;
	if (corepack.reason === "unresolved-required") {
		return {
			detail: describeCorepackLeg(corepack),
			remedy:
				"restore the root package.json `packageManager` pin (a `pnpm@<full-version>` string), then re-run",
		};
	}
	const pin = failure.required?.version ?? null;
	const pinned = pin === null ? "the pinned pnpm" : `pnpm@${pin}`;
	// A verified-wrong PATH pnpm still proves a working pnpm exists, so `pnpm dlx` is runnable
	// there; an undetermined PATH proves nothing, so the remedy is to install the pin outright.
	const remedy =
		path.kind === "version-mismatch"
			? `run \`pnpm dlx ${pinned} install --frozen-lockfile\` from the repo root, or pin pnpm to ${pin} in your toolchain manager, then re-run`
			: `install ${pinned} with your toolchain manager (or enable corepack), then re-run`;
	return {detail: `${describePathLeg(path)}; ${describeCorepackLeg(corepack)}`, remedy};
};
