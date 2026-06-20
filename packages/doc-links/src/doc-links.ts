/**
 * `@kampus/doc-links` core — the pure, IO-free derivation behind the repo-wide
 * dead-internal-link gate (#638). `gate.ts` wires it to the filesystem (walk the
 * git-tracked `.md` files, resolve each link target against disk); this file
 * holds the parsing logic so it is unit-testable over plain strings, with no
 * disk (the core-in-its-own-file idiom; #855).
 *
 * What counts as a checkable link: a markdown inline link `[text](target)` whose
 * target is *internal* (a relative/absolute on-disk path, not `http(s):`, a
 * `mailto:`/`tel:` scheme, a bare `#fragment`, or a protocol-relative `//host`).
 * Links written inside inline code spans (`` `…` ``) or fenced code blocks
 * (```` ``` ````) are NOT links per markdown semantics — they are literal text,
 * the form docs use to *show* link syntax (CLAUDE.md's `[text](relative/path.md)`
 * example, the `/adr` template's `[NNNN](NNNN-slug.md)` placeholder). Skipping
 * code is what keeps the gate from flagging those intentional examples; it is a
 * correctness rule, not an allowlist hack.
 */

/** A markdown link extracted from a doc: its raw target and 1-based source line. */
export interface DocLink {
	/** The raw target as written, e.g. `../foo.md#section`. */
	readonly target: string;
	readonly line: number;
}

/**
 * Blank out inline code spans and fenced code blocks so a `[x](y)` written *as an
 * example* inside them is not parsed as a link. Replaces code runs with spaces of
 * equal length (newlines preserved) so 1-based line numbers stay accurate for the
 * surviving links.
 *
 * Fences first (a backtick fence can span lines and contain stray `` ` ``), then
 * inline spans on what's left. The inline rule matches a run of N backticks, then
 * the shortest content, then a closing run of the SAME N backticks — CommonMark's
 * code-span delimiter rule.
 */
export const maskCode = (text: string): string => {
	const blank = (m: string) => m.replace(/[^\n]/g, " ");
	return text
		.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, blank)
		.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, blank);
};

const LINK_RE = /\[(?:[^\]]*)\]\(([^)\s]+)/g;

/**
 * A target is *external* (not our concern) when it carries a URL scheme, is a bare
 * in-page anchor, or is protocol-relative. Everything else is an on-disk path the
 * gate must resolve. Note: `path#frag` and `path?q` ARE internal (the fragment/query
 * is stripped before resolution by the caller).
 */
export const isExternal = (target: string): boolean =>
	target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target);

/** Drop a trailing `#fragment` and/or `?query` — only the file path resolves on disk. */
export const stripFragment = (target: string): string => target.split(/[#?]/, 1).join("");

/**
 * Extract the internal markdown links from a doc's text. Masks code first, then
 * pulls every `[…](target)`, drops external targets, and yields the rest with their
 * source line. Empty targets (e.g. `[x]()`) are skipped.
 */
export const extractInternalLinks = (text: string): ReadonlyArray<DocLink> => {
	const masked = maskCode(text);
	const links: DocLink[] = [];
	LINK_RE.lastIndex = 0;
	for (let m = LINK_RE.exec(masked); m !== null; m = LINK_RE.exec(masked)) {
		const target = (m[1] ?? "").trim();
		if (target === "" || isExternal(target)) continue;
		const line = masked.slice(0, m.index).split("\n").length;
		links.push({target, line});
	}
	return links;
};

/** A dead link: where it was written and what it pointed at. */
export interface DeadLink {
	readonly file: string;
	readonly line: number;
	readonly target: string;
}

/**
 * Given a doc's path + text and a predicate "does this resolved path exist?",
 * return the dead internal links in it. The resolve+exists IO is the injected
 * predicate, so this stays pure (the gate passes a real `existsSync`-backed one).
 */
export const findDeadLinksIn = (
	file: string,
	text: string,
	exists: (file: string, target: string) => boolean,
): ReadonlyArray<DeadLink> =>
	extractInternalLinks(text).flatMap((link) =>
		exists(file, stripFragment(link.target)) ? [] : [{file, line: link.line, target: link.target}],
	);

/**
 * Walk up from `start` for the first ancestor for which `hasMarker(dir)` holds,
 * returning that directory; or `null` if the filesystem root is reached without a
 * hit. Pure (the IO — "does this dir carry a marker?" — is the injected predicate),
 * so the upward-walk logic is unit-testable without touching disk. `dirname` is the
 * only path op: `dirname("/") === "/"` is the fixpoint that ends the walk.
 * (Mirrors `@kampus/decisions-index`'s `findRootDir`.)
 */
export const findRootDir = (
	start: string,
	hasMarker: (dir: string) => boolean,
	dirname: (p: string) => string,
): string | null => {
	let dir = start;
	for (;;) {
		if (hasMarker(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
};

/** Render the failure report: one `file:line  →  target` line per dead link. */
export const renderReport = (dead: ReadonlyArray<DeadLink>): string => {
	const lines = dead.map((d) => `  ${d.file}:${d.line}  →  ${d.target}`);
	return (
		`Found ${dead.length} dead internal doc link${dead.length === 1 ? "" : "s"} ` +
		`(target does not resolve on disk):\n${lines.join("\n")}\n\n` +
		"Fix the link target, or restore the file it points at. Links inside code\n" +
		"spans/fences are ignored, so wrap an intentional example in backticks."
	);
};
