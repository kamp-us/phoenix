/**
 * `readme-guard` pure core — decide whether every real `packages/*` workspace
 * member carries a `README.md` (issues #938/#939). IO-free and total: every
 * decision is a deterministic transform over already-gathered facts. The
 * filesystem boundary (enumerate dirs, stat `package.json`/`README.md`, read the
 * workspace file) lives in `gate.ts`; this module never touches disk.
 *
 * The scoping is the load-bearing detail. A `packages/*` directory is a real
 * workspace member ONLY when it contains a `package.json`; a bare directory with
 * none is a dead shell (the #1003 pipeline-cli consolidation left ~10 such
 * stragglers — a stale `.turbo/` log and nothing else, tracked for removal by
 * #1351), NOT a package. So the guard FILTERS candidates to `package.json`-bearing
 * members before checking for a README — otherwise it would red-fail on every dead
 * shell. The dead-shell-ignoring logic is unit-tested here, in the pure core.
 *
 * Fail-closed on zero scope (ADR 0092): if the scan finds zero members it is a
 * misconfiguration (wrong root, a workspace reshape), NOT a silent pass — the
 * verdict is a failure, never a vacuous green.
 */

/**
 * One immediate `packages/*` subdirectory reduced to the two facts the decision
 * needs. `hasPackageJson` is what separates a real workspace member from a dead
 * shell; `hasReadme` is what the guard requires of a member. Both gathered at the
 * filesystem boundary (`gate.ts`).
 */
export interface PackageDirCandidate {
	/** Repo-relative directory, e.g. `packages/ci-required`. */
	readonly dir: string;
	readonly hasPackageJson: boolean;
	readonly hasReadme: boolean;
}

/**
 * The guard verdict. A discriminated union so an invalid state is unrepresentable:
 * a pass never carries a `missing` list, and the two failure shapes (zero-scope vs
 * a member missing its README) are distinct and each carries exactly its evidence.
 */
export type ReadmeGuardVerdict =
	| {readonly pass: true; readonly members: ReadonlyArray<string>}
	/** No `package.json`-bearing member found — fail closed, never a vacuous pass (ADR 0092). */
	| {readonly pass: false; readonly reason: "zero-scope"}
	/** Real members exist but at least one lacks a `README.md`. */
	| {
			readonly pass: false;
			readonly reason: "missing-readme";
			readonly members: ReadonlyArray<string>;
			readonly missing: ReadonlyArray<string>;
	  };

/**
 * Decide the verdict over the enumerated candidates. Filters to real workspace
 * members (those with a `package.json`) first — so dead-shell dirs are ignored —
 * then fails closed on zero members (ADR 0092), else reds on any member without a
 * `README.md`.
 */
export const judge = (candidates: ReadonlyArray<PackageDirCandidate>): ReadmeGuardVerdict => {
	const members = candidates.filter((c) => c.hasPackageJson);
	if (members.length === 0) {
		return {pass: false, reason: "zero-scope"};
	}
	const memberDirs = members.map((m) => m.dir);
	const missing = members.filter((m) => !m.hasReadme).map((m) => m.dir);
	if (missing.length > 0) {
		return {pass: false, reason: "missing-readme", members: memberDirs, missing};
	}
	return {pass: true, members: memberDirs};
};

/** Render the human-readable failure report for a non-passing verdict (ADR 0092 §1 "emit what you scanned"). */
export const renderReport = (verdict: ReadmeGuardVerdict): string => {
	if (verdict.pass) {
		return `readme-guard: all ${verdict.members.length} packages/* workspace members carry a README.md`;
	}
	if (verdict.reason === "zero-scope") {
		return (
			"readme-guard: scanned ZERO packages/* workspace members (no directory with a package.json) — " +
			"fail-closed (ADR 0092). Is the repo root correct, or did the workspace shape change?"
		);
	}
	const lines = verdict.missing.map((d) => `  ${d}`);
	return (
		`readme-guard: ${verdict.missing.length} packages/* workspace member` +
		`${verdict.missing.length === 1 ? "" : "s"} lack a README.md ` +
		`(of ${verdict.members.length} scanned):\n${lines.join("\n")}\n\n` +
		"Every packages/* workspace package must carry a README.md (what it is, why it\n" +
		"exists, how to use it). Add one to each listed directory."
	);
};

/**
 * Extract the `packages:` sequence globs from a `pnpm-workspace.yaml`'s text. Pure
 * over the file text so `gate.ts` can ground its scan in the declared workspace
 * shape rather than a hardcoded `"packages"` literal: the guard asserts `packages/*`
 * is a declared member glob before scanning, and the scope tracks the workspace.
 *
 * Minimal, dependency-free YAML slice — reads the top-level `packages:` block's
 * `- <glob>` items and stops at the next top-level key (a non-indented `key:`
 * line). Sufficient for this file's flat shape; not a general YAML parser.
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
		// A new top-level key (non-indented, not a list item) ends the packages block.
		if (/^\S/.test(line) && !line.startsWith("-")) break;
		const m = /^\s*-\s*(.+?)\s*$/.exec(line);
		if (m?.[1] !== undefined) {
			out.push(m[1].replace(/^['"]|['"]$/g, ""));
		}
	}
	return out;
};
