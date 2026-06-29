/**
 * `pointer-guard` pure core — the IO-free derivation behind the fail-closed
 * stale-pointer gate for `**​/CLAUDE.md` (#988). `gate.ts` wires it to the
 * filesystem (list the git-tracked CLAUDE.md files, resolve each reference against
 * the repo tree); this file holds the extraction + path-likeness logic so it is
 * unit-testable over plain strings, with no disk (the core-in-its-own-file idiom;
 * #855).
 *
 * The gap this closes is the one the `doc-links` gate (#638) cannot see by
 * construction. `doc-links` validates markdown `[text](path)` links and
 * deliberately *masks* code spans, because a `[x](y)` written inside backticks is
 * an example, not a link. But CLAUDE.md leans on a *different* reference class:
 * **backticked prose path pointers** — "operate from the repo root, never
 * `apps/web`", "enforce with `pipeline-cli readme-guard check`", a pointer at
 * `apps/web/worker/dom/settings.ts`. When the referenced file is renamed or moved,
 * that backticked pointer rots silently — `doc-links` masks exactly the spans this
 * guard must read. The two gates are complementary: `doc-links` reads link targets
 * and masks code; `pointer-guard` reads code spans and ignores link syntax.
 *
 * Scope: `**​/CLAUDE.md` only (AC #1). `.decisions/**` is excluded on purpose — it
 * is the immutable *history* surface (CLAUDE.md: ".decisions/ = the why + history,
 * including superseded approaches"), so an ADR legitimately points at code that has
 * since moved or been deleted (a dropped `wrangler.jsonc`, a renamed `Pasaport.ts`);
 * resolving those against the *current* tree would red-flag the record itself.
 * `.patterns/**` is excluded too: besides the same drift it would surface, its prose
 * cites *external* dependency source trees (`packages/effect/src/Effect.ts`,
 * `packages/fate/src/server/live.ts`) that are not in-repo paths and are
 * indistinguishable from a deleted in-repo package by resolution alone — an
 * irreducible false-positive source. CLAUDE.md is the canonical agent-routing
 * surface the report centers on, and it resolves cleanly.
 *
 * Precision over recall (AC #3). Not every backticked token is a path
 * (`catalog:`, `type:bug`, `pnpm dev`, a regex, a code snippet). The guard flags a
 * token ONLY when it is an unambiguous **repo-root-relative** path: a single
 * whitespace-free token, no scheme / glob / call / placeholder syntax, that begins
 * with a known repo top-level segment (`apps/`, `packages/`, `.patterns/`, …). That
 * deliberately ignores bare basenames (`config.ts`) and app-relative shorthand
 * (`worker/db/resources.ts`) — ambiguous forms a prose doc uses freely — and keeps
 * the gate from crying wolf, at the cost of not catching a stale *partial* pointer.
 */

/** A backticked candidate pointer extracted from a doc: the resolvable path + its 1-based source line. */
export interface PathRef {
	/** The cleaned repo-root-relative path token, e.g. `apps/web/worker/index.ts`. */
	readonly path: string;
	readonly line: number;
}

/**
 * Repo top-level segments a root-relative pointer must begin with to be treated as
 * a path. A token that does not start with one of these is ambiguous shorthand (a
 * bare basename, an app-relative fragment) and is left alone — the precision lever.
 */
const KNOWN_PREFIX_RE =
	/^(apps|packages|infra|docs|\.patterns|\.decisions|\.glossary|\.claude|\.github|claude-plugins)\//;

/** Tokens carrying any of these are not plain paths: globs, calls, placeholders, regex, redirects, vars. */
const NON_PATH_SYNTAX_RE = /[*?{}[\]!()<>$|]/;

/** A `scheme:` prefix (`https:`, `catalog:`, `type:bug`, `mailto:`) — not a repo path. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Reduce one backticked span's raw content to a repo-root-relative path token, or
 * `null` if it is not an unambiguous path reference. Total and pure — every
 * rejection is a syntactic property of the token, never a disk lookup.
 */
export const toPathRef = (raw: string): string | null => {
	let t = raw.trim().replace(/^['"]|['"]$/g, "");
	// Drop trailing prose punctuation a sentence attaches to an inline span.
	t = t.replace(/[.,;:]+$/g, "");
	// Drop a #fragment / ?query, then a trailing :line(:col) source-locator suffix.
	t = t.split(/[#?]/, 1)[0] ?? "";
	t = t.replace(/:\d+(:\d+)?$/, "");
	if (t === "" || /\s/.test(t)) return null; // a command / prose, not a single path
	if (SCHEME_RE.test(t)) return null;
	if (NON_PATH_SYNTAX_RE.test(t)) return null;
	if (t.startsWith("@")) return null; // an npm scope (`@kampus/web`), not a path
	if (/(^|\/)\.\.(\/|$)|\w\.\.|\.\.\w/.test(t)) return null; // `..` traversal / `work..` shorthand
	if (!KNOWN_PREFIX_RE.test(t)) return null;
	return t.replace(/\/+$/, ""); // normalize a trailing slash so a dir resolves
};

/**
 * Blank out fenced code blocks so a path written inside a ```bash example (a
 * command, a template like `apps/web/.env`) is not read as a live pointer.
 * Replaces fence runs with spaces of equal length (newlines preserved) so 1-based
 * line numbers stay accurate for the inline spans that survive. Inline spans are
 * exactly what this guard reads, so — unlike `doc-links` — they are NOT masked.
 */
export const maskFences = (text: string): string =>
	text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, (m) =>
		m.replace(/[^\n]/g, " "),
	);

const INLINE_SPAN_RE = /(`+)((?:(?!\1)[\s\S])*?)\1/g;

/**
 * Extract the repo-root-relative path references from a doc's text: mask fenced
 * blocks, then pull every inline code span and keep the ones `toPathRef` accepts,
 * each with its source line.
 */
export const extractPathRefs = (text: string): ReadonlyArray<PathRef> => {
	const masked = maskFences(text);
	const refs: PathRef[] = [];
	INLINE_SPAN_RE.lastIndex = 0;
	for (let m = INLINE_SPAN_RE.exec(masked); m !== null; m = INLINE_SPAN_RE.exec(masked)) {
		const path = toPathRef(m[2] ?? "");
		if (path === null) continue;
		const line = masked.slice(0, m.index).split("\n").length;
		refs.push({path, line});
	}
	return refs;
};

/** A stale pointer: where it was written and what repo-relative path it named. */
export interface StalePointer {
	readonly file: string;
	readonly line: number;
	readonly path: string;
}

/**
 * Given a doc's path + text and a predicate "does this repo-relative path resolve?",
 * return the stale pointers in it. The resolve+exists IO is the injected predicate,
 * so this stays pure (the gate passes a real `existsSync`-backed one).
 */
export const findStalePointersIn = (
	file: string,
	text: string,
	exists: (path: string) => boolean,
): ReadonlyArray<StalePointer> =>
	extractPathRefs(text).flatMap((ref) =>
		exists(ref.path) ? [] : [{file, line: ref.line, path: ref.path}],
	);

/** Render the failure report: one `file:line  →  path` line per stale pointer (ADR 0092 §1 "emit what you scanned"). */
export const renderReport = (stale: ReadonlyArray<StalePointer>): string => {
	const lines = stale.map((s) => `  ${s.file}:${s.line}  →  ${s.path}`);
	return (
		`pointer-guard: ${stale.length} stale CLAUDE.md pointer${stale.length === 1 ? "" : "s"} ` +
		`(backticked repo path does not resolve on disk):\n${lines.join("\n")}\n\n` +
		"Fix the pointer to the path's current location, or restore the file it names.\n" +
		"Only repo-root-relative backticked paths (apps/…, packages/…, .patterns/…) are\n" +
		"checked; wrap an intentional non-path token so it is not read as a pointer."
	);
};
