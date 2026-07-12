/**
 * `codeowners-cp` core — the pure, IO-free derivation behind the §CP↔CODEOWNERS
 * drift gate (#955). `gate.ts` wires it to the filesystem (read the canonical
 * `CONTROL_PLANE_RE` line + `.github/CODEOWNERS`); this file holds the parsing so
 * it is unit-testable over plain strings, with no disk (the core-in-its-own-file
 * idiom; #855).
 *
 * The drift it closes: the §CP control-plane set is a single anchored regex
 * (`CONTROL_PLANE_RE`, canonical in `gh-issue-intake-formats.md`), but
 * `.github/CODEOWNERS` enumerates the same paths LITERALLY. A pattern-set and a
 * literal-enumeration set drift silently — a §CP path added to the regex without a
 * CODEOWNERS row is then control-plane-by-regex yet NOT covered by
 * `require_code_owner_review` (under-protected; bit on #934/#953). This core reads
 * the §CP set FROM the regex (never a re-hardcoded copy — that's the whole point)
 * and checks every §CP path branch has a covering CODEOWNERS entry.
 */

/**
 * One §CP path the regex marks control-plane: a path + its shape.
 * - `dir`  — a directory prefix (keeps its trailing `/`).
 * - `file` — an exact `$`-anchored leaf (no trailing `/`).
 * - `glob` — a within-segment wildcard leaf: a `[^/]+` regex class translated to a
 *   gitignore `*` (e.g. `.../skills/*.sh`), owned by a matching `*`-glob CODEOWNERS row.
 */
export interface CpPath {
	/** Normalized path with no leading `/`. A `dir` keeps its trailing `/`; `file`/`glob` have none. */
	readonly path: string;
	readonly kind: "dir" | "file" | "glob";
}

/** A CODEOWNERS pattern with at least one owner: the normalized pattern (no leading `/`) + its owners. */
export interface OwnedPattern {
	/** The pattern as written, leading `/` stripped; a trailing `/` (directory) is preserved. */
	readonly pattern: string;
	readonly owners: ReadonlyArray<string>;
}

/**
 * Extract the canonical `CONTROL_PLANE_RE` regex string from the formats doc.
 *
 * The single machine-readable form every §CP consumer uses is the shell assignment
 * `CONTROL_PLANE_RE='…'` (the one ship-it Step 0 / review-code Step 2 read). We pull
 * from THAT line, not the fenced prose copy, so we track the exact string the gates
 * run against. Returns `null` when no such assignment is found — the caller fails
 * closed on a `null` (ADR 0092: can't parse the source ⇒ refuse, never pass).
 */
export const extractControlPlaneRe = (formatsText: string): string | null => {
	const m = formatsText.match(/CONTROL_PLANE_RE='([^']*)'/);
	return m?.[1] ?? null;
};

/**
 * Split the §CP regex into its top-level path-prefix branches.
 *
 * `CONTROL_PLANE_RE` is `^b1|^b2|…` — every branch is `^`-anchored, and an inner
 * alternation inside a group (`(a|b)`) is `…|a…`, never `…|^…`. So splitting on the
 * literal boundary `|^` cleaves the top-level branches without ever cutting an inner
 * alternative. The leading `^` is stripped first so the first branch is bare.
 */
export const splitTopLevelBranches = (re: string): ReadonlyArray<string> =>
	re.replace(/^\^/, "").split("|^");

/**
 * Expand a single top-level branch into its concrete §CP path(s).
 *
 * A branch is a path-prefix regex with at most one alternation group, e.g.
 * `(\.claude|\.github)/`, `…/skills/(ship-it|review-code|…)/`, or
 * `…/hooks(/|\.json$)`. We cartesian-expand every `(…)` group, then normalize each
 * expansion to a path: unescape `\.`→`.` and drop a regex `$` end-anchor. A trailing
 * `/` ⇒ a directory prefix; a `[^/]+` within-segment class ⇒ a `glob` (translated to a
 * gitignore `*`, e.g. `.../skills/[^/]+\.sh$` → `.../skills/*.sh`); otherwise an exact
 * file (the `$`-anchored leaf).
 */
export const expandBranch = (branch: string): ReadonlyArray<CpPath> => {
	const normalize = (s: string): CpPath => {
		const base = s.replace(/\$/g, "").replace(/\\\./g, ".");
		// `[^/]+` (one-or-more non-slash) is a within-segment regex wildcard; gitignore's
		// `*` (which CODEOWNERS uses) means the same, so translate it to a real glob a
		// CODEOWNERS row can own (the bare gate-critical `skills/*.sh` guards — ADR 0174).
		if (base.includes("[^/]+")) {
			return {path: base.replace(/\[\^\/\]\+/g, "*"), kind: "glob"};
		}
		return {path: base, kind: base.endsWith("/") ? "dir" : "file"};
	};
	// Cartesian-expand each `(alt|alt|…)` group, left to right. The regex only ever
	// carries one group per branch, but expanding all groups keeps this robust to a
	// future multi-group branch.
	let forms: string[] = [branch];
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
			for (const alt of (inner ?? "").split("|")) {
				next.push(before + alt + after);
			}
		}
		forms = next;
		if (!expandedAny) break;
	}
	return forms.map(normalize);
};

/**
 * The full §CP path set the regex resolves to: every top-level branch expanded.
 * Returns `[]` only when the regex itself is empty/garbage — the caller treats an
 * empty result as a fail-closed condition (zero-scope ⇒ refuse, ADR 0092).
 */
export const cpPaths = (re: string): ReadonlyArray<CpPath> =>
	splitTopLevelBranches(re)
		.flatMap(expandBranch)
		.filter((p) => p.path !== "");

/**
 * Parse `.github/CODEOWNERS` into the owned patterns. Comment (`#`) and blank lines
 * are skipped; each remaining line is `pattern owner [owner…]`. Only lines that
 * assign at least one owner count — an owner-less line (which would *unset* ownership
 * in CODEOWNERS semantics) covers nothing here. The leading `/` is stripped so the
 * pattern compares directly against a repo-relative §CP path; a trailing `/` is kept.
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
 * - A directory entry (`e` ends `/`) covers `p` when `p` is the dir itself or sits
 *   under it (`p === e` or `p.startsWith(e)`). Note this does NOT cover a sibling
 *   file: `hooks/` does not cover `hooks.json` (`"hooks.json".startsWith("hooks/")`
 *   is false) — that file needs its own row, which is exactly the §CP `hooks` branch
 *   splitting into two literal CODEOWNERS rows.
 * - A non-directory entry covers `p` by exact match, or as an ancestor directory
 *   named without a trailing slash (`p.startsWith(e + "/")`, gitignore's bare-name
 *   dir semantics).
 * - A `glob` §CP path (e.g. `.../skills/*.sh`) is covered by an identical `*`-glob
 *   CODEOWNERS row, or by an ancestor directory entry that owns the whole segment it
 *   sits in.
 */
export const covers = (e: OwnedPattern, p: CpPath): boolean => {
	const pat = e.pattern;
	if (p.kind === "glob") {
		if (pat === p.path) return true;
		const dir = p.path.slice(0, p.path.lastIndexOf("/") + 1);
		return pat.endsWith("/") && (dir === pat || dir.startsWith(pat));
	}
	if (pat.endsWith("/")) return p.path === pat || p.path.startsWith(pat);
	return p.path === pat || p.path.startsWith(`${pat}/`);
};

/** The §CP paths NOT covered by any owned CODEOWNERS entry. Empty ⇒ in sync. */
export const findUncovered = (
	paths: ReadonlyArray<CpPath>,
	patterns: ReadonlyArray<OwnedPattern>,
): ReadonlyArray<CpPath> => paths.filter((p) => !patterns.some((e) => covers(e, p)));

/** Render the failure report: one `path  (kind)` line per uncovered §CP path. */
export const renderReport = (uncovered: ReadonlyArray<CpPath>): string => {
	const lines = uncovered.map((p) => `  ${p.path}  (${p.kind})`);
	return (
		`Found ${uncovered.length} §CP control-plane path${uncovered.length === 1 ? "" : "s"} ` +
		`with NO covering .github/CODEOWNERS entry:\n${lines.join("\n")}\n\n` +
		"Every path the §CP CONTROL_PLANE_RE marks control-plane MUST be owned in CODEOWNERS,\n" +
		"else require_code_owner_review leaves it under-protected. Add a literal CODEOWNERS row\n" +
		"(owned by a human) for each path above — or, if a path left the §CP regex, drop it there\n" +
		"too. (#955; the canonical regex lives in gh-issue-intake-formats.md.)"
	);
};
