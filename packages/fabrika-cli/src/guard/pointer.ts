/**
 * `pointer-guard`'s pure half — which backticked repo paths a `CLAUDE.md` points at, so the gate can
 * ask whether each still resolves (#988).
 *
 * This closes the gap the `doc-links` gate cannot see by construction. `doc-links` validates
 * markdown `[text](path)` links and deliberately MASKS code spans, because a `[x](y)` inside
 * backticks is an example rather than a link. But CLAUDE.md leans on a different reference class:
 * backticked prose pointers — "operate from the repo root, never `apps/web`", a pointer at
 * `apps/web/worker/dom/settings.ts`. When the target moves, that pointer rots unseen. The two gates
 * are complementary: one reads link targets and masks code, this one reads code spans and ignores
 * link syntax.
 *
 * **Precision over recall.** Not every backticked token is a path — `catalog:`, `type:bug`, `pnpm
 * dev`, a regex, a snippet. A token is treated as a pointer only when it is unambiguously
 * repo-root-relative: whitespace-free, no scheme or glob or call or placeholder syntax, and
 * beginning with a known repo top-level segment. That ignores bare basenames and app-relative
 * shorthand, which prose uses freely, at the cost of missing a stale partial pointer. A gate that
 * cries wolf is a gate people route around.
 */

/** A backticked candidate pointer: the cleaned repo-root-relative path and its 1-based line. */
export interface PathRef {
	readonly path: string;
	readonly line: number;
}

/**
 * Repo top-level segments a pointer must begin with.
 *
 * This is the precision lever: a token starting anywhere else is ambiguous shorthand and is left
 * alone.
 */
const KNOWN_PREFIX =
	/^(apps|packages|infra|docs|\.patterns|\.decisions|\.glossary|\.claude|\.github|claude-plugins)\//;

/** Globs, calls, placeholders, regex, redirects, vars — none of them a plain path. */
const NON_PATH_SYNTAX = /[*?{}[\]!()<>$|]/;

/** A `scheme:` prefix — `https:`, `catalog:`, `type:bug`, `mailto:`. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * One backticked span reduced to a repo-root-relative path token, or `null` when it is not
 * unambiguously one. Total and pure: every rejection is a syntactic property of the token.
 */
export const toPathRef = (raw: string): string | null => {
	let token = raw.trim().replace(/^['"]|['"]$/g, "");
	token = token.replace(/[.,;:]+$/g, "");
	token = token.split(/[#?]/, 1)[0] ?? "";
	token = token.replace(/:\d+(:\d+)?$/, "");
	if (token === "" || /\s/.test(token)) return null;
	if (SCHEME.test(token)) return null;
	if (NON_PATH_SYNTAX.test(token)) return null;
	if (token.startsWith("@")) return null;
	if (/(^|\/)\.\.(\/|$)|\w\.\.|\.\.\w/.test(token)) return null;
	if (!KNOWN_PREFIX.test(token)) return null;
	return token.replace(/\/+$/, "");
};

/**
 * Blank out fenced code blocks so a path inside a ```bash example is not read as a live pointer.
 *
 * Fence runs become spaces of equal length with newlines preserved, so the 1-based line numbers of
 * the inline spans that survive stay accurate. Inline spans are exactly what this guard reads, so —
 * unlike `doc-links` — they are NOT masked.
 */
export const maskFences = (text: string): string =>
	text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, (block) =>
		block.replace(/[^\n]/g, " "),
	);

const INLINE_SPAN = /(`+)((?:(?!\1)[\s\S])*?)\1/g;

/** The repo-root-relative pointers in a doc's text, each with its source line. */
export const extractPathRefs = (text: string): ReadonlyArray<PathRef> => {
	const masked = maskFences(text);
	const refs: Array<PathRef> = [];
	INLINE_SPAN.lastIndex = 0;
	for (let m = INLINE_SPAN.exec(masked); m !== null; m = INLINE_SPAN.exec(masked)) {
		const path = toPathRef(m[2] ?? "");
		if (path === null) continue;
		refs.push({path, line: masked.slice(0, m.index).split("\n").length});
	}
	return refs;
};

/** A pointer that no longer resolves: where it was written and what it named. */
export interface StalePointer {
	readonly file: string;
	readonly line: number;
	readonly path: string;
}

/**
 * The stale pointers in one doc, given a "does this repo-relative path resolve?" predicate.
 *
 * The predicate is injected because resolution is the IO half — and it answers "exists OR is
 * gitignored", not "exists": CLAUDE.md legitimately points at a deliberately-absent generated path
 * the doc tells you to create (`apps/web/.env`, gitignored and so absent in a fresh checkout). That
 * is a valid pointer, not rot.
 */
export const stalePointersIn = (
	file: string,
	text: string,
	resolves: (path: string) => boolean,
): ReadonlyArray<StalePointer> =>
	extractPathRefs(text).flatMap((ref) =>
		resolves(ref.path) ? [] : [{file, line: ref.line, path: ref.path}],
	);

/** The report: one `file:line → path` row per stale pointer, then the remedy. */
export const staleReport = (verb: string, stale: ReadonlyArray<StalePointer>): string =>
	[
		`${verb}: ${stale.length} stale CLAUDE.md pointer${stale.length === 1 ? "" : "s"} (a backticked repo path that does not resolve on disk):`,
		...stale.map((s) => `  ${s.file}:${s.line}  →  ${s.path}`),
		"",
		"Fix the pointer to the path's current location, or restore the file it names. Only",
		"repo-root-relative backticked paths (apps/…, packages/…, .patterns/…) are checked; wrap an",
		"intentional non-path token so it is not read as a pointer.",
	].join("\n");
