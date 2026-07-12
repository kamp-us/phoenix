/**
 * `catalog-guard` pure core — decide whether every dependency in every workspace
 * `package.json` is sourced via the pnpm `catalog:` (or an internal `workspace:`
 * ref), with no hardcoded version string (issue #2737). IO-free and total: every
 * decision is a deterministic transform over already-gathered manifest facts. The
 * filesystem boundary (enumerate members, read each manifest + the workspace file)
 * lives in `gate.ts`; this module never touches disk.
 *
 * The rule the guard enforces is CLAUDE.md's "Every dependency via `catalog:`": one
 * shared version per dep, declared once in `pnpm-workspace.yaml`. A hardcoded semver
 * introduces a second version and breaks frozen-lockfile CI downstream — the exact
 * PR #535 failure mode (`@distilled.cloud/cloudflare` hardcoded). The convention was
 * written but unenforced, so it held only by reviewer vigilance; this guard closes
 * the gap deterministically.
 *
 * Fail-closed on zero scope (ADR 0092): if the scan finds zero manifests it is a
 * misconfiguration (wrong root, a workspace reshape), NOT a silent pass — the
 * verdict is a failure, never a vacuous green.
 */

/** One dependency entry from a manifest, reduced to the facts the decision needs. */
export interface DepEntry {
	/** Which manifest field it came from — `dependencies` / `devDependencies` / `peerDependencies`. */
	readonly field: string;
	readonly name: string;
	/** The raw version specifier, e.g. `catalog:`, `workspace:*`, or a hardcoded `^1.2.3`. */
	readonly value: string;
}

/** A workspace `package.json` reduced to its repo-relative path and its dep entries. */
export interface PackageManifest {
	/** Repo-relative path, e.g. `packages/foo/package.json` or `package.json` (root). */
	readonly path: string;
	readonly deps: ReadonlyArray<DepEntry>;
}

/**
 * An explicit, reasoned exception to the catalog rule (issue #2737: "a genuinely
 * unavoidable non-catalog dep goes in an explicit, reasoned allowlist — never a
 * silent tolerance"). A dep is exempt only when its `name` matches AND (`path` is
 * unset OR equals the manifest's path). `reason` is mandatory so an exception can
 * never be added without a recorded justification.
 */
export interface AllowlistEntry {
	readonly name: string;
	/** Scope the exemption to a single manifest; unset ⇒ exempt in every manifest. */
	readonly path?: string;
	readonly reason: string;
}

/**
 * The allowlist of sanctioned non-catalog deps. Empty today — every workspace member
 * is already on `catalog:`/`workspace:`. Add an entry ONLY for a genuinely unavoidable
 * exception, each with a recorded `reason`; a silent tolerance is a bug (issue #2737).
 */
export const DEFAULT_ALLOWLIST: ReadonlyArray<AllowlistEntry> = [];

/** A hardcoded-version violation: a dep whose value is neither `catalog:` nor `workspace:` nor allowlisted. */
export interface CatalogViolation {
	readonly path: string;
	readonly field: string;
	readonly name: string;
	readonly value: string;
}

/**
 * The guard verdict. A discriminated union so an invalid state is unrepresentable: a
 * pass never carries violations, and the two failure shapes (zero-scope vs hardcoded
 * versions) are distinct and each carries exactly its evidence.
 */
export type CatalogGuardVerdict =
	| {readonly pass: true; readonly scanned: ReadonlyArray<string>}
	/** No manifest in scope — fail closed, never a vacuous pass (ADR 0092). */
	| {readonly pass: false; readonly reason: "zero-scope"}
	/** Manifests exist but at least one dep pins a hardcoded (non-catalog) version. */
	| {
			readonly pass: false;
			readonly reason: "hardcoded-versions";
			readonly scanned: ReadonlyArray<string>;
			readonly violations: ReadonlyArray<CatalogViolation>;
	  };

/** A dep value is compliant iff it defers to the catalog or to an internal workspace package. */
const isCompliantValue = (value: string): boolean =>
	value.startsWith("catalog:") || value.startsWith("workspace:");

const isAllowlisted = (
	entry: DepEntry,
	path: string,
	allowlist: ReadonlyArray<AllowlistEntry>,
): boolean =>
	allowlist.some((a) => a.name === entry.name && (a.path === undefined || a.path === path));

/**
 * Decide the verdict over the enumerated manifests. Fails closed on zero manifests
 * (ADR 0092), else reds on any dep whose value is neither `catalog:` / `workspace:`
 * nor an allowlisted exception.
 */
export const judge = (
	manifests: ReadonlyArray<PackageManifest>,
	allowlist: ReadonlyArray<AllowlistEntry> = DEFAULT_ALLOWLIST,
): CatalogGuardVerdict => {
	if (manifests.length === 0) {
		return {pass: false, reason: "zero-scope"};
	}
	const scanned = manifests.map((m) => m.path);
	const violations: Array<CatalogViolation> = [];
	for (const m of manifests) {
		for (const dep of m.deps) {
			if (isCompliantValue(dep.value)) continue;
			if (isAllowlisted(dep, m.path, allowlist)) continue;
			violations.push({path: m.path, field: dep.field, name: dep.name, value: dep.value});
		}
	}
	if (violations.length > 0) {
		return {pass: false, reason: "hardcoded-versions", scanned, violations};
	}
	return {pass: true, scanned};
};

/** Render the human-readable failure report for a non-passing verdict (ADR 0092 §1 "emit what you scanned"). */
export const renderReport = (verdict: CatalogGuardVerdict): string => {
	if (verdict.pass) {
		return `catalog-guard: all deps in ${verdict.scanned.length} workspace manifest${verdict.scanned.length === 1 ? "" : "s"} are on catalog:/workspace:`;
	}
	if (verdict.reason === "zero-scope") {
		return (
			"catalog-guard: scanned ZERO package.json manifests — fail-closed (ADR 0092). " +
			"Is the repo root correct, or did the workspace shape change?"
		);
	}
	// Each line follows the `<what's wrong> — <why + issue ref>. Fix: <step>.` convention (#2737).
	const lines = verdict.violations.map(
		(v) =>
			`  ${v.path}: ${v.field} \`${v.name}\` pins \`${v.value}\` instead of \`catalog:\` — ` +
			"a second version of a dep breaks frozen-lockfile CI (#535). " +
			`Fix: add \`${v.name}\` to the catalog: block in pnpm-workspace.yaml and set the dep value to \`catalog:\`.`,
	);
	return (
		`catalog-guard: ${verdict.violations.length} dependenc${verdict.violations.length === 1 ? "y" : "ies"} ` +
		`pin a hardcoded version instead of catalog: (of ${verdict.scanned.length} manifests scanned):\n${lines.join("\n")}`
	);
};

/**
 * Extract the `packages:` sequence globs from a `pnpm-workspace.yaml`'s text. Pure
 * over the file text so `gate.ts` can ground its member scan in the declared workspace
 * shape rather than a hardcoded literal.
 *
 * Minimal, dependency-free YAML slice — reads the top-level `packages:` block's
 * `- <glob>` items and stops at the next top-level key (a non-indented `key:` line).
 * Sufficient for this file's flat shape; not a general YAML parser.
 */
export const parseWorkspacePackageGlobs = (yaml: string): ReadonlyArray<string> => {
	const out: Array<string> = [];
	let inPackages = false;
	for (const raw of yaml.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (/^packages:\s*$/.test(line)) {
			inPackages = true;
			continue;
		}
		if (!inPackages) continue;
		if (/^\S/.test(line) && !line.startsWith("-")) break;
		const m = /^\s*-\s*(.+?)\s*$/.exec(line);
		if (m?.[1] !== undefined) {
			out.push(m[1].replace(/^['"]|['"]$/g, ""));
		}
	}
	return out;
};

/** The manifest fields the catalog rule governs (issue #2737 acceptance criteria). */
export const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const;

/**
 * Flatten a parsed `package.json` object into `DepEntry`s over the governed fields.
 * Pure over the already-parsed object so `gate.ts` only owns the read+JSON.parse.
 */
export const manifestDeps = (pkg: Record<string, unknown>): ReadonlyArray<DepEntry> => {
	const out: Array<DepEntry> = [];
	for (const field of DEP_FIELDS) {
		const block = pkg[field];
		if (block === null || typeof block !== "object") continue;
		for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
			if (typeof value === "string") out.push({field, name, value});
		}
	}
	return out;
};
