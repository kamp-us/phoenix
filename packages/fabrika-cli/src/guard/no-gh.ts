/**
 * The matchers behind `guard no-gh check`: is there a `gh` invocation left in this package's source?
 *
 * Epic #6629 swapped every GitHub call in `packages/fabrika-cli/` off the `gh` binary and onto the
 * fetch client in `../io/gh-api.ts`, so that a fabrika verb runs from a token alone — on a phone, on
 * a lean CI image, in a consumer repo. Nothing but this guard holds that: one `execFileSync("gh", …)`
 * puts the binary back on the request path and no test anywhere notices.
 *
 * **Comments are stripped before anything is matched.** This package's docblocks talk about `gh` at
 * length — they have to, they record what the port replaced — and a guard that could not tell
 * `` `gh api --paginate` `` in a sentence from `execCapture("gh", …)` on a line would force every
 * such note out of the source. {@link codeOf} does the stripping with a string-literal-aware scanner
 * rather than a `//`-to-end-of-line cut, because `"https://api.github.com"` is a `//` that starts no
 * comment and truncating there would hide whatever follows it.
 */

export interface Finding {
	readonly file: string;
	/** 1-based line number of the offending line. */
	readonly line: number;
	/** The exact substring that matched — what the report shows and the sanction list is keyed on. */
	readonly matched: string;
	readonly reason: string;
}

export interface ScanFile {
	readonly file: string;
	readonly content: string;
}

export interface ScanResult {
	readonly findings: ReadonlyArray<Finding>;
	/** Every file path the scan looked at — its scope, so a green states what it rests on (ADR 0092). */
	readonly scanned: ReadonlyArray<string>;
}

const SPAWNED =
	"a `gh` subprocess — this package speaks HTTP through `src/io/gh-api.ts` (ADR 0315)";

/**
 * `"gh"` / `'gh'` on its own: the binary named in argv position, whatever spawns it —
 * `execCapture("gh", …)`, `execFileSync("gh", …)`, `{file: "gh"}`. This one needs no context, because
 * a quoted `gh` in TypeScript is a command name and nothing else. The backtick spelling of the same
 * argv is {@link GH_ARGV_TEMPLATE}, which does need context.
 */
const GH_ARGV = /(['"])gh\1/g;

/**
 * A quoted command line carrying `gh <subcommand>`, either at its start (`sh -c 'gh api …'`) or after
 * a shell operator (`… && gh api …`).
 *
 * Unlike {@link GH_ARGV} these only fire beside {@link EXEC_MARKER}, and the narrowing is what makes
 * the check usable at all: this package's own guard corpus, its verb descriptions and its test
 * fixtures are full of `gh` command text that is data, not a call — `skill-lint.ts` exists to forbid
 * `gh api graphql` and has to quote it to do so. Judging runnable text only is the same narrowing
 * `scanBarePush` makes with its fences.
 */
const GH_SHELL_STRING = /(['"`])\s*gh\s+[a-z][a-z-]*/g;
const GH_CHAINED = /(?:&&|\|\||;|\|)\s*gh\s+[a-z][a-z-]*/g;

/**
 * `` `gh` `` in argv position — ``execCapture(`gh`, …)`` spawns exactly as `execCapture("gh", …)` does.
 *
 * Gated on {@link EXEC_MARKER} rather than folded into {@link GH_ARGV}, because backticked `gh` is
 * also how this package spells the binary in prose, and prose is not only in comments {@link codeOf}
 * strips: `config/keys/surface-dispositions.ts` names the surface in a `note:` string, and a widened
 * {@link GH_ARGV} would red that sentence.
 */
const GH_ARGV_TEMPLATE = /`gh`/g;

/** A line that spawns something, or hands `-c` to a shell — where a command string is a command. */
const EXEC_MARKER =
	/\b(?:execCapture|execRecord|execSync|execFile|execFileSync|spawnSync|spawn)\s*\(|(['"])-c\1/;

/**
 * How far back a spawn is still this string's spawn: the marker's own line, or one of the two above
 * it, which is where an argv array wrapped by the formatter puts it.
 */
const EXEC_WINDOW = 2;

const isRunnable = (lines: ReadonlyArray<string>, index: number): boolean => {
	for (let i = Math.max(0, index - EXEC_WINDOW); i <= index; i++) {
		if (EXEC_MARKER.test(lines[i] ?? "")) return true;
	}
	return false;
};

interface Sanctioned {
	readonly file: string;
	/** The top-level declaration the sanctioned spawn sits inside — {@link enclosingSymbols}. */
	readonly symbol: string;
	readonly matched: string;
}

/**
 * The one `gh` spawn this package keeps, named by file, by the declaration that holds it, and by the
 * exact text that matched — and spendable **once**.
 *
 * ADR 0315 rules the credential order `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token` — the last a
 * developer-machine convenience resolved once, before any request, never on a request path.
 *
 * Keying on the matched text alone was a file-wide licence for the one spelling that matters: every
 * argv spawn produces the same `"gh"`, so any number of them added anywhere in `gh-api.ts` passed
 * silently, and `gh-api.ts` is the most plausible file for such a call to come back to. The site key
 * plus the single-use rule is what the docblock always claimed and the unit test always pinned.
 */
const SANCTIONED: ReadonlyArray<Sanctioned> = [
	{file: "/src/io/gh-api.ts", symbol: "resolveToken", matched: '"gh"'},
];

/**
 * The guard's own files, which cannot be scanned by it: a guard must spell out what it forbids, and
 * every pattern above is a literal example of the thing.
 *
 * Per-file by suffix, never a directory — a `src/guard/`-wide exemption would silently drop every
 * future guard from the scan.
 */
const SELF_EXEMPT_SUFFIXES = [
	"/src/guard/no-gh.ts",
	"/src/guard/no-gh-verb.ts",
	"/src/guard/no-gh.unit.test.ts",
	"/src/guard/no-gh-verb.unit.test.ts",
] as const;

const normalize = (path: string): string => `/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`;

export const isSelfExempt = (path: string): boolean => {
	const p = normalize(path);
	return SELF_EXEMPT_SUFFIXES.some((suffix) => p.endsWith(suffix));
};

/**
 * A top-level `const`/`let`/`function`/`class` declaration, at column 0.
 *
 * Column 0 is the whole test, and it holds because biome formats this package with tabs: anything
 * nested is indented. A `gh` spawn the scanner cannot place — before the first declaration, or in a
 * file shaped some other way — gets `null` and matches no sanction, which is the fail-closed
 * direction.
 */
const TOP_LEVEL_DECL =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;

/** For each line, the nearest top-level declaration at or above it — the call site a sanction names. */
const enclosingSymbols = (lines: ReadonlyArray<string>): ReadonlyArray<string | null> => {
	const out: Array<string | null> = [];
	let current: string | null = null;
	for (const line of lines) {
		const named = TOP_LEVEL_DECL.exec(line)?.[1];
		if (named !== undefined) current = named;
		out.push(current);
	}
	return out;
};

/**
 * The sanction row this match spends, or `null` when none covers it.
 *
 * Returns the row rather than a boolean so {@link scanFile} can spend it: a sanction names one call,
 * so a second match against the same row is a second call and reds.
 */
const sanctionFor = (file: string, symbol: string | null, matched: string): Sanctioned | null => {
	const p = normalize(file);
	return (
		SANCTIONED.find(
			(row) => p.endsWith(row.file) && row.symbol === symbol && row.matched === matched,
		) ?? null
	);
};

/**
 * `content` with its comments blanked out, one output line per input line so a finding still names
 * the line it is on.
 *
 * String literals are tracked, so `//` inside one starts no comment; a template literal's `${…}`
 * holes are not parsed as code, which costs nothing here — an interpolated `gh` command still shows
 * its literal prefix.
 */
export const codeOf = (content: string): ReadonlyArray<string> => {
	const out: Array<string> = [];
	let inBlock = false;
	for (const line of content.split("\n")) {
		let code = "";
		let quote: string | null = null;
		let i = 0;
		while (i < line.length) {
			const c = line[i] ?? "";
			if (inBlock) {
				if (c === "*" && line[i + 1] === "/") {
					inBlock = false;
					i += 2;
					continue;
				}
				i++;
				continue;
			}
			if (quote !== null) {
				code += c;
				if (c === "\\") {
					code += line[i + 1] ?? "";
					i += 2;
					continue;
				}
				if (c === quote) quote = null;
				i++;
				continue;
			}
			if (c === "/" && line[i + 1] === "/") break;
			if (c === "/" && line[i + 1] === "*") {
				inBlock = true;
				i += 2;
				continue;
			}
			if (c === '"' || c === "'" || c === "`") quote = c;
			code += c;
			i++;
		}
		out.push(code);
	}
	return out;
};

/** Every `gh` invocation in one file's code, comments and sanctioned legs already taken out. */
export const scanFile = (file: string, content: string): ReadonlyArray<Finding> => {
	if (isSelfExempt(file)) return [];
	const findings: Array<Finding> = [];
	const lines = codeOf(content);
	const symbols = enclosingSymbols(lines);
	const spent = new Set<Sanctioned>();
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i] ?? "";
		const patterns = isRunnable(lines, i)
			? [GH_ARGV, GH_ARGV_TEMPLATE, GH_SHELL_STRING, GH_CHAINED]
			: [GH_ARGV];
		for (const pattern of patterns) {
			pattern.lastIndex = 0;
			for (const match of text.matchAll(pattern)) {
				const matched = match[0];
				if (findings.some((f) => f.line === i + 1 && f.matched === matched)) continue;
				const sanction = sanctionFor(file, symbols[i] ?? null, matched);
				if (sanction !== null && !spent.has(sanction)) {
					spent.add(sanction);
					continue;
				}
				findings.push({file, line: i + 1, matched, reason: SPAWNED});
			}
		}
	}
	return findings;
};

export const scanPackage = (files: ReadonlyArray<ScanFile>): ScanResult => ({
	findings: files.flatMap((f) => scanFile(f.file, f.content)),
	scanned: files.filter((f) => !isSelfExempt(f.file)).map((f) => f.file),
});

/** A scan that looked at nothing proves nothing — the fail-closed floor (ADR 0092). */
export const isZeroScope = (result: ScanResult): boolean => result.scanned.length === 0;
