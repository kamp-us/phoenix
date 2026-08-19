/**
 * `guard codeowners-cp check` core — every path the §CP regex marks control-plane has a covering
 * `.github/CODEOWNERS` row.
 *
 * The drift it closes (#955): §CP is one anchored regex, CODEOWNERS enumerates the same paths
 * LITERALLY, and a pattern set and a literal set drift silently. A §CP path added to the regex with
 * no CODEOWNERS row is control-plane by regex yet outside `require_code_owner_review` — and because
 * the `main` ruleset pairs `required_approving_review_count: 0` with `require_code_owner_review:
 * true`, a path matching NO row merges on ZERO approvals (#934/#953). This reads the §CP set FROM
 * the regex, never a re-hardcoded copy.
 *
 * **This is the one §CP site that is deliberately PATH-ONLY, and it is not a defect** (#4161).
 * Everywhere else a bare path answer is non-authoritative — §CP has a second, content-inferred
 * source (a guard-touching `.decisions/**` ADR, ADR 0164). CODEOWNERS structurally cannot express a
 * content predicate: GitHub matches it on paths. So the content clause is enforced at the
 * merge-deciding gates, which is where a merge is actually decided.
 *
 * IO-free: pure over the CODEOWNERS text and the regex const. The read lives in
 * `./codeowners-cp-verb.ts`.
 */

/**
 * One §CP path the regex marks control-plane.
 *
 * - `dir` — a directory prefix (keeps its trailing `/`).
 * - `file` — an exact `$`-anchored leaf (no trailing `/`).
 * - `glob` — a within-segment wildcard leaf: a `[^/]+` regex class translated to a gitignore `*`.
 */
export interface CpPath {
	/** Normalized, no leading `/`. A `dir` keeps its trailing `/`; `file`/`glob` have none. */
	readonly path: string;
	readonly kind: "dir" | "file" | "glob";
}

/** A CODEOWNERS pattern with at least one owner: the pattern (no leading `/`) plus its owners. */
export interface OwnedPattern {
	readonly pattern: string;
	readonly owners: ReadonlyArray<string>;
}

/**
 * Split the §CP regex into its top-level path-prefix branches.
 *
 * The regex is `^b1|^b2|…` — every branch is `^`-anchored, and an inner alternation inside a group
 * (`(a|b)`) is `…|a…`, never `…|^…`. So splitting on the literal boundary `|^` cleaves the
 * top-level branches without ever cutting an inner alternative.
 */
export const splitTopLevelBranches = (re: string): ReadonlyArray<string> =>
	re.replace(/^\^/, "").split("|^");

/**
 * Expand one top-level branch into its concrete §CP path(s): cartesian-expand every `(…)` group,
 * then normalize each expansion to a path (unescape `\.`, drop the `$` anchor).
 */
export const expandBranch = (branch: string): ReadonlyArray<CpPath> => {
	// `([^/]+/)*` is the any-depth segment prefix (#2950) — a QUANTIFIED group, so the alternation
	// loop below cannot expand it. Translate it up front to CODEOWNERS' `**/`.
	const anyDepth = branch.replace(/\(\[\^\/\]\+\/\)\*/g, "**/");
	const normalize = (s: string): CpPath => {
		const base = s.replace(/\$/g, "").replace(/\\\./g, ".");
		// `[^/]+` and gitignore's `*` both mean "one or more non-slash", so a within-segment regex
		// wildcard becomes a real glob a CODEOWNERS row can own (ADR 0174).
		if (base.includes("[^/]+")) {
			return {path: base.replace(/\[\^\/\]\+/g, "*"), kind: "glob"};
		}
		return {path: base, kind: base.endsWith("/") ? "dir" : "file"};
	};
	let forms: string[] = [anyDepth];
	const groupRe = /\(([^()]*)\)/;
	for (let guard = 0; guard < 16; guard++) {
		const next: string[] = [];
		let expandedAny = false;
		for (const form of forms) {
			const g = form.match(groupRe);
			if (g === null) {
				next.push(form);
				continue;
			}
			expandedAny = true;
			const [whole, inner] = g;
			const idx = form.indexOf(whole);
			const before = form.slice(0, idx);
			const after = form.slice(idx + whole.length);
			for (const alt of (inner ?? "").split("|")) next.push(before + alt + after);
		}
		forms = next;
		if (!expandedAny) break;
	}
	return forms.map(normalize);
};

/** Every §CP path the regex resolves to. An empty result is the caller's zero-scope red. */
export const cpPaths = (re: string): ReadonlyArray<CpPath> =>
	splitTopLevelBranches(re)
		.flatMap(expandBranch)
		.filter((p) => p.path !== "");

/**
 * Parse `.github/CODEOWNERS` into its owned patterns. Only lines assigning at least one owner count
 * — an owner-less line UNSETS ownership in CODEOWNERS semantics, so it covers nothing here.
 */
export const parseCodeownersPatterns = (codeownersText: string): ReadonlyArray<OwnedPattern> => {
	const out: OwnedPattern[] = [];
	for (const raw of codeownersText.split("\n")) {
		const line = raw.replace(/#.*$/, "").trim();
		if (line === "") continue;
		const [pattern, ...owners] = line.split(/\s+/);
		if (pattern === undefined || owners.length === 0) continue;
		out.push({pattern: pattern.replace(/^\//, ""), owners});
	}
	return out;
};

/**
 * Does CODEOWNERS pattern `e` cover §CP path `p`?
 *
 * A directory entry does NOT cover a sibling file — `hooks/` does not cover `hooks.json`, which is
 * exactly why the §CP `hooks` branch needs two literal CODEOWNERS rows.
 */
export const covers = (e: OwnedPattern, p: CpPath): boolean => {
	const pat = e.pattern;
	if (p.kind === "glob") {
		if (pat === p.path) return true;
		const dir = p.path.slice(0, p.path.lastIndexOf("/") + 1);
		return pat.endsWith("/") && (dir === pat || dir.startsWith(pat));
	}
	if (pat.endsWith("/")) return p.path === pat || p.path.startsWith(pat);
	// A bare name is gitignore's ancestor-directory form as well as an exact file.
	return p.path === pat || p.path.startsWith(`${pat}/`);
};

/** The §CP paths no owned CODEOWNERS entry covers. Empty means in sync. */
export const findUncovered = (
	paths: ReadonlyArray<CpPath>,
	patterns: ReadonlyArray<OwnedPattern>,
): ReadonlyArray<CpPath> => paths.filter((p) => !patterns.some((e) => covers(e, p)));

const VERB = "guard codeowners-cp check";

/** The human report: one `path  (kind)` line per uncovered §CP path, plus the remedy. */
export const renderReport = (uncovered: ReadonlyArray<CpPath>): string => {
	const lines = uncovered.map((p) => `  ${p.path}  (${p.kind})`);
	return (
		`${VERB}: ${uncovered.length} §CP control-plane path${uncovered.length === 1 ? "" : "s"} ` +
		`with NO covering .github/CODEOWNERS entry:\n${lines.join("\n")}\n\n` +
		"Every path the §CP boundary marks control-plane MUST be owned in CODEOWNERS, else\n" +
		"require_code_owner_review leaves it under-protected — and at the ruleset's zero required\n" +
		"approvals, a path matching no row merges with no approval at all. Add a literal CODEOWNERS\n" +
		"row (owned by a human team) for each path above — or, if a path left the §CP boundary, drop\n" +
		"it from `control-plane-re.ts` too. (#955)"
	);
};
