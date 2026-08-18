/**
 * The **committed-file** leak scanner behind `build check`'s prose validators — the gated surface,
 * as distinct from `report/leaks.ts`, which guards runtime issue bodies nothing else covers.
 *
 * The two surfaces want different answers, and `build check` used to ask the body scanner about a
 * file in a diff (#5687). Three divergences followed, all of them live:
 *
 *  1. **Segment class.** The body scanner's path segment permits regex punctuation, so a bare home
 *     marker followed by an alternation bar inside a fenced code block parses as a path. Here a
 *     segment must be name-shaped, so a quoted regex literal is not a path.
 *  2. **Surface scoping.** Temp/scratch roots (`/tmp/…`, `/var/folders/…`) are a *comment*-surface
 *     rule: a public comment has no legitimate bare-`/tmp` example, a doc does. This scanner carries
 *     the home/absolute arm alone.
 *  3. **Self-exemption.** A doc whose subject IS path hygiene must spell the shapes out. That set is
 *     repo policy, so it is read from `.fabrika.jsonc`, not compiled in here (see `repo-config.ts`).
 *
 * **Why the shapes are re-declared, and what keeps them honest.** phoenix's `leak-guard` owns the
 * authoritative gate, but ADR 0238 forbids a fabrika verb running v1 code and ADR 0273 makes
 * fabrika installable into a repo that has no `pipeline-cli` at all, so neither side can derive the
 * shapes from the other. ADR 0251 rules what stands in for the import: the canonical bytes are
 * committed as the golden fixture `__fixtures__/doc-leak-patterns.golden.json`, and each side pins
 * it in a test of its own — `doc-leak-patterns.golden.test.ts` here, and
 * `fabrika-doc-leak-conformance.test.ts` on the gate's side, which reads this fixture. Drift on
 * either side reds. The fixture pins regex source and flags; the `reason` strings below are this
 * scanner's own report text and deliberately are not shared vocabulary.
 *
 * The scars carried across, each already paid for once upstream:
 *
 *  - The `(?<![A-Za-z]:)` drive-letter carve-out on the `/Users/` arm: a Windows file URL
 *    (`file:///C:/Users/ci/…`) is not a macOS home leak, and flagging it blocked legitimate PRs.
 *  - The `~/.claude` arm's two negative lookaheads: `~/.claude.json` and `~/.claude/settings.json`
 *    are the claude CLI's public, machine-agnostic config *files*, byte-identical everywhere, and
 *    every MCP-registration doc names them. Any deeper descent or longer name still flags. The
 *    carve-out is a property of the shape, never a membership list.
 *  - The generic sibling-clone arm matches `~/<root>/<host.tld>/<user>/<repo>` by **lookahead**, so
 *    the matched span is the home prefix only — the same span the `~/code/` arm reports.
 *
 * Every arm is a generic structural shape. None of them names an operator, a machine or a repo.
 */

/** A machine-local path shape, and the report line it produces. */
export interface PathPattern {
	readonly pattern: RegExp;
	readonly reason: string;
}

/** Report order = pattern order. Every `g` flag is required for the per-line `matchAll` scan. */
export const DOC_PATH_PATTERNS: ReadonlyArray<PathPattern> = [
	{
		pattern: /(?<![A-Za-z]:)\/Users\/[A-Za-z0-9._-]+/g,
		reason: "absolute macOS home path",
	},
	{
		pattern: /(?<![\w.])~\/\.(usirin|agent)\b/g,
		reason: "agent/tool home dir",
	},
	{
		pattern: /(?<![\w.])~\/\.claude(?!\.json(?![\w.]))(?!\/settings\.json(?![\w.]))\b/g,
		reason: "agent home-dir internals",
	},
	{
		pattern: /(?<![\w.])~\/code\//g,
		reason: "home-dir sibling-repo clone",
	},
	{
		pattern:
			/(?<![\w.])~\/[A-Za-z0-9._-]+\/(?=[A-Za-z0-9-]+\.[A-Za-z]{2,}\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/g,
		reason: "home-dir sibling-repo clone under an unnamed clone root",
	},
	{
		pattern: /(?<![\w/])\/vault\//g,
		reason: "vault path",
	},
];

export interface DocLeak {
	/** 1-based line number in the scanned file — what the defect line prints. */
	readonly line: number;
	readonly matched: string;
	readonly reason: string;
}

const DOC_SUFFIXES = [".md", ".mdx", ".markdown"] as const;
const DOC_DIRS = ["/.decisions/", "/.patterns/"] as const;

const normalize = (path: string): string => path.replace(/\\/g, "/");

/** Leading-slash a path so a relative target matches the same token an absolute one does. */
const rooted = (path: string): string => `/${normalize(path).replace(/^\/+/, "")}`;

/**
 * Whether `path` is a committed prose surface this scanner reads at all.
 *
 * Scoping lives here and nowhere else, so a file cannot be scanned by one caller and skipped by
 * another — the drift shape that let two copies of one pattern set disagree upstream.
 */
export const isDocSurface = (path: string): boolean => {
	const p = normalize(path);
	if (DOC_SUFFIXES.some((suffix) => p.endsWith(suffix))) return true;
	return DOC_DIRS.some((dir) => rooted(p).includes(dir));
};

/** Whether the repo declared `path` a doc whose subject is path hygiene. Suffix match, as declared. */
export const isDocLeakExempt = (path: string, exempt: ReadonlyArray<string>): boolean => {
	const p = rooted(path);
	return exempt.some((entry) => p.endsWith(rooted(entry)));
};

/**
 * Every machine-local path `text` carries, with its line, scoped to `path`'s surface.
 *
 * Fenced code is scanned like every other line, deliberately: a fence is a likely place for a real
 * leak to sit, and skipping fences would make this predictor *looser* than the gate it predicts.
 * The fenced-regex false positive is closed by the segment class instead.
 */
export const docLeaks = (
	path: string,
	text: string,
	exempt: ReadonlyArray<string>,
): ReadonlyArray<DocLeak> => {
	if (!path || !text) return [];
	if (!isDocSurface(path)) return [];
	if (isDocLeakExempt(path, exempt)) return [];
	const leaks: DocLeak[] = [];
	const seen = new Set<string>();
	for (const [index, line] of text.split("\n").entries()) {
		for (const {pattern, reason} of DOC_PATH_PATTERNS) {
			for (const match of line.matchAll(pattern)) {
				// Two arms legitimately claim one span — `~/code/` is both the named clone root and the
				// generic `~/<root>/<host>/<user>/<repo>` shape — and reporting the same bytes twice
				// makes one leak read as two. Deduped on the span, so the count is the leak count.
				const key = `${index}\t${match.index}\t${match[0]}`;
				if (seen.has(key)) continue;
				seen.add(key);
				leaks.push({line: index + 1, matched: match[0], reason});
			}
		}
	}
	return leaks;
};
