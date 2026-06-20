/**
 * `@kampus/publish-guard` core — the offline, deterministic publishability check
 * (epic #803, child #807).
 *
 * For each required `@kampus/*` package, cross-check its `package.json`: a
 * package the plugin consumes MUST be publishable — `publishConfig.access:
 * "public"` and **not** `private: true`. The check reads config only — no
 * network — so the PR gate that calls it can't flake (epic #803 Resolved
 * questions: offline/config-only, network presence checks belong elsewhere).
 *
 * `checkDrift` is pure over already-loaded manifests (`PackageManifest | null`,
 * `null` = not found on disk); `loadPackageManifest` is the thin IO that reads
 * one `package.json` off the workspace. Splitting them keeps the verdict logic
 * fixture-testable with no filesystem.
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";

/** The fields of a `package.json` this guard reads. */
export interface PackageManifest {
	readonly private?: boolean;
	readonly publishConfig?: {readonly access?: string};
}

/** Why a required package is (un)publishable. One per required package. */
export type DriftStatus = "ok" | "private-but-required" | "missing-publishConfig" | "not-found";

export interface PackageVerdict {
	readonly name: string;
	readonly status: DriftStatus;
}

export interface DriftReport {
	readonly verdicts: ReadonlyArray<PackageVerdict>;
	/** True iff at least one verdict is not `ok` — the CLI's non-zero-exit signal. */
	readonly hasDrift: boolean;
}

/** The single-package verdict, in precedence order: not-found → private → access. */
const verdictFor = (manifest: PackageManifest | null): DriftStatus => {
	if (manifest === null) return "not-found";
	if (manifest.private === true) return "private-but-required";
	if (manifest.publishConfig?.access !== "public") return "missing-publishConfig";
	return "ok";
};

/**
 * Cross-check every required package against its loaded manifest. `packages` maps
 * a required name to its `PackageManifest`, or `null` when no `package.json` was
 * found for it. The result is sorted by name for a stable report/table.
 */
export const checkDrift = (
	required: ReadonlyArray<string>,
	packages: Readonly<Record<string, PackageManifest | null>>,
): DriftReport => {
	const verdicts = [...required].sort().map((name) => ({
		name,
		status: verdictFor(name in packages ? (packages[name] ?? null) : null),
	}));
	return {verdicts, hasDrift: verdicts.some((v) => v.status !== "ok")};
};

/**
 * Read `packagesDir/<name>/package.json` as a `PackageManifest`, or `null` when
 * it is missing/unreadable/unparseable (→ a `not-found` verdict, never a crash).
 */
export const loadPackageManifest = (packagesDir: string, name: string): PackageManifest | null => {
	try {
		const raw = readFileSync(join(packagesDir, name, "package.json"), "utf8");
		return JSON.parse(raw) as PackageManifest;
	} catch {
		return null;
	}
};

/** Load every required package's manifest off `packagesDir` (IO; for the bin). */
export const loadManifests = (
	packagesDir: string,
	required: ReadonlyArray<string>,
): Record<string, PackageManifest | null> => {
	const out: Record<string, PackageManifest | null> = {};
	for (const name of required) out[name] = loadPackageManifest(packagesDir, name);
	return out;
};
