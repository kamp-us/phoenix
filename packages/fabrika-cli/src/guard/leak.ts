/**
 * The authoritative leak gate's pure half — does a committed file put a machine-local filesystem
 * path into a shared artifact (#173, #312)? Ported off v1's `leak-guard scan` (epic #5720).
 *
 * CI is the unbypassable surface here: it is the only place that sees every PR's diff whatever
 * wrote it (an agent tool, an editor, a `cat >`, a human commit), which is why the rule lives as a
 * required check rather than a write-time hook.
 *
 * **Two surfaces, `doc` and `shell`.** Shell was added because the doc-only premise expired: the
 * rule was written when all pipeline shell lived inside markdown fences, and extracting that shell
 * into standalone `.sh` files walked the exact bytes off the guard's surface while the required
 * check kept exiting 0 (#4496). A `.sh` is scanned whole, comments included — unlike an
 * *invocation* guard, a machine-local path is a leak wherever it sits in a committed file, and a
 * shell comment is the likeliest place for one to land.
 *
 * **The path shapes live here rather than in a module of their own.** In v1 they sat in a separate
 * `path-matcher.ts` because two detectors consumed them and a carve-out had landed on one copy only
 * (#3506). Here the gate is the single consumer, so a second file would be indirection with no
 * second reader. What still keeps the shapes honest is ADR 0251's golden fixture: `build check
 * --surface prose` predicts this gate in-tree from its own copy in `../build/doc-leaks.ts`, and
 * `./leak.golden.test.ts` pins this list against the same committed bytes that one pins against.
 *
 * Every arm is a generic structural shape. None names an operator, a machine or a repo (#2393).
 */

/** A machine-local path shape, and the report line it produces. */
export interface PathPattern {
	readonly pattern: RegExp;
	readonly reason: string;
}

/** Report order = pattern order. Every `g` flag is required for the `matchAll` scan below. */
export const MACHINE_LOCAL_PATH_PATTERNS: ReadonlyArray<PathPattern> = [
	{
		// The drive-letter lookbehind keeps this generic while dropping the Windows-file-URL false
		// positive: a bare POSIX `/Users/<name>/` is a real macOS home leak, but a drive-prefixed
		// `file:///C:/Users/ci/…` is not, and flagging it fail-closed-blocked legitimate PRs (#3070).
		pattern: /(?<![A-Za-z]:)\/Users\/[A-Za-z0-9._-]+/g,
		reason: "absolute macOS home path (/Users/<name>/...)",
	},
	{
		pattern: /(?<![\w.])~\/\.(usirin|agent)\b/g,
		reason: "agent/tool home dir (~/.usirin, ~/.agent)",
	},
	{
		// Narrowed by SHAPE, never by a membership list (#2393, #3475): the two negative lookaheads
		// carve out the claude CLI's public, machine-agnostic config *files* — byte-identical on
		// every machine and named by every MCP-registration doc — while any deeper descent into the
		// private home tree still flags. The `(?![\w.])` tail pins each carve-out to the exact leaf,
		// so `~/.claude.json.bak` or `~/.claude/settings.local.json` still trips.
		pattern: /(?<![\w.])~\/\.claude(?!\.json(?![\w.]))(?!\/settings\.json(?![\w.]))\b/g,
		reason:
			"agent/tool home dir (~/.claude internals; public config files ~/.claude.json, ~/.claude/settings.json exempt)",
	},
	{
		pattern: /(?<![\w.])~\/code\//g,
		reason: "home-dir sibling-repo clone (~/code/...)",
	},
	{
		// The generic clone shape under ANY root (#3401): a forge-host segment — a `<name>.<tld>`
		// component — between one home clone-root segment and a `<user>/<repo>` tail is a checked-out
		// clone wherever the author roots their clones. The tail is a LOOKAHEAD, so the matched span
		// is the home prefix only, mirroring the `~/code/` arm; consuming the whole path instead made
		// the redactor wipe the forge tail. A single clone-root segment is deliberate: allowing more
		// would match a `~/Library/…/com.x.y/…` reverse-DNS bundle path.
		pattern:
			/(?<![\w.])~\/[A-Za-z0-9._-]+\/(?=[A-Za-z0-9-]+\.[A-Za-z]{2,}\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/g,
		reason: "home-dir sibling-repo clone (~/<root>/<host>/<user>/<repo>)",
	},
	{
		pattern: /(?<![\w/])\/vault\//g,
		reason: "vault path (/vault/...)",
	},
];

/** One finding: the exact substring that matched, and the class it matched. */
export interface Leak {
	readonly matched: string;
	readonly reason: string;
}

const DOC_SUFFIXES = [".md", ".mdx", ".markdown"] as const;
const DOC_DIRS = ["/.decisions/", "/.patterns/"] as const;

// Extension-scoped and deliberately NOT directory-scoped: confining the shell surface to
// `claude-plugins/` would rebuild the same narrow surface one level down, so the next script
// extracted anywhere else would walk off it exactly as these did. `.sh` is the whole tracked shell
// corpus — no `.bash`/`.zsh` file exists — so this is the corpus, not a guess at it.
const SHELL_SUFFIXES = [".sh"] as const;

/**
 * Files whose subject IS path hygiene: they must spell the forbidden shapes out, so they are exempt
 * by path suffix.
 *
 * The MARKDOWN members of this list are declared a second time, in `.fabrika.jsonc`'s
 * `docLeakExempt`, for the in-tree predictor that scans markdown only. `./leak.golden.test.ts`
 * holds the two equal, so a doc added to one side and not the other reds (ADR 0251).
 */
export const DOC_SELF_EXEMPT = [
	"/packages/fabrika-cli/src/guard/leak.ts",
	"/packages/fabrika-cli/src/guard/leak.unit.test.ts",
	"/packages/fabrika-cli/src/guard/leak-verb.ts",
	"/packages/fabrika-cli/src/guard/leak-verb.unit.test.ts",
	"/packages/leak-guard/README.md",
	"/skills/review-doc/SKILL.md",
	"/skills/triage/SKILL.md",
	"/skills/report/SKILL.md",
	// The triager's output-privacy rule names the machine-local shapes it forbids in a return
	// summary (#1956) — rule text, not real paths, so routine edits must not trip the guard.
	"/agents/triager.md",
	"/skills/report/footer.sh",
	// A harness whose whole job is proving a corpus carries none of the forbidden shapes, so it must
	// enumerate them as pattern arms — exempt for the same reason this file is (#4449).
	"/skills/write-code/scripts/verify-fail-closed.sh",
	// Its Lineage section names the sibling-repo clones this repo was rebuilt from.
	"/CLAUDE.md",
] as const;

const normalize = (path: string): string => path.replace(/\\/g, "/");

/** Leading-slash a path so a relative target matches the same token an absolute one does. */
const rooted = (path: string): string => `/${normalize(path).replace(/^\/+/, "")}`;

/** Which shared-artifact surface a path belongs to, or `null` when it is out of scope entirely. */
export type Surface = "doc" | "shell";

/**
 * The surface `path` belongs to.
 *
 * Every scoping decision resolves here, so a surface cannot be scanned by one caller and skipped by
 * another — the drift shape that let two copies of one pattern set disagree (#3506).
 */
export const surfaceOf = (path: string): Surface | null => {
	const p = normalize(path);
	if (SHELL_SUFFIXES.some((suffix) => p.endsWith(suffix))) return "shell";
	if (DOC_SUFFIXES.some((suffix) => p.endsWith(suffix))) return "doc";
	return DOC_DIRS.some((dir) => rooted(p).includes(dir)) ? "doc" : null;
};

export const isSelfExempt = (path: string): boolean => {
	const p = rooted(path);
	return DOC_SELF_EXEMPT.some((entry) => p.endsWith(entry));
};

/** Every leak in `text`, deduped on matched+reason, scoped to `filePath`'s surface. */
export const findLeaks = (filePath: string, text: string): ReadonlyArray<Leak> => {
	if (!filePath || !text) return [];
	if (surfaceOf(filePath) === null) return [];
	if (isSelfExempt(filePath)) return [];
	const seen = new Set<string>();
	const leaks: Array<Leak> = [];
	for (const {pattern, reason} of MACHINE_LOCAL_PATH_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			const key = `${match[0]}\t${reason}`;
			if (seen.has(key)) continue;
			seen.add(key);
			leaks.push({matched: match[0], reason});
		}
	}
	return leaks;
};

/** One handed file's outcome — its findings plus how the scan classified it. */
export interface ScannedFile {
	readonly file: string;
	readonly leaks: ReadonlyArray<Leak>;
	readonly surface: Surface | null;
	readonly exempt: boolean;
}

/**
 * How many handed files landed in each outcome.
 *
 * Per surface and not as one total: the defect this closes was a silently narrowing surface — `.sh`
 * left the scan when shell moved out of markdown fences (#4496) — and a single "N files scanned"
 * cannot tell a healthy markdown surface from one carrying the whole count while the shell surface
 * contributes nothing.
 */
export const scopeLine = (scanned: ReadonlyArray<ScannedFile>): string => {
	const live = scanned.filter((r) => !r.exempt);
	const count = (surface: Surface) => live.filter((r) => r.surface === surface).length;
	return `${scanned.length} file(s) handed: ${count("doc")} doc surface, ${count("shell")} shell surface, ${scanned.filter((r) => r.exempt).length} self-exempt, ${live.filter((r) => r.surface === null).length} out of scope`;
};
