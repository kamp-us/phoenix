/**
 * `i18n-guard`'s pure half — does a Turkish string literal or a Turkish run of JSX text still sit
 * in `apps/web/src` outside the catalog (#7536, epic #7519)?
 *
 * The rule is ADR [0347](../../../../.decisions/0347-web-copy-behind-i18n-catalog.md): every user
 * surface reads its copy through `apps/web/src/i18n`, so Turkish text living in a component is copy
 * the reader can never see in English. `.patterns/i18n-catalog.md` is the shape a migration takes.
 *
 * Three things are deliberately NOT copy and are not judged: a comment (`.glossary/LANGUAGE.md`
 * keeps prose bilingual by design), a regex literal (a character class over `çğıöşü` is a fold
 * table, not a sentence), and an unquoted object key (an identifier position — `ç: "c"`).
 *
 * Scope and the fail-closed floor live at the IO boundary in `./i18n-literal-verb.ts`; this module
 * never touches disk and never decides what a scan covered.
 */

import {type Annotation, atLine} from "./annotate.ts";

/**
 * The six Turkish letters ASCII does not carry, in both cases. `İ` and `ı` are the dotted/dotless
 * pair; `I` and `i` are shared with English and are therefore not a signal.
 */
const TURKISH = /[çğıöşüÇĞİÖŞÜ]/u;

/** Where a Turkish run was found. The two arms are the two things the issue's rule names. */
export type HitKind =
	/** Inside a `"`, `'` or template literal — the ordinary un-migrated copy. */
	| "string"
	/** Bare source text, which in a `.tsx` file is JSX text between two tags. */
	| "jsx-text";

export interface TurkishHit {
	/** 1-based, so it addresses an editor and a GitHub annotation directly. */
	readonly line: number;
	readonly kind: HitKind;
	/** The offending run, trimmed and capped — enough to recognise, never a whole file. */
	readonly excerpt: string;
}

const EXCERPT_MAX = 80;

const excerptOf = (text: string): string => {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX - 1)}…` : flat;
};

/**
 * A `/` opens a regex only where a value cannot already be sitting to its left; anywhere else it is
 * division. Comments are consumed before this is consulted, so `//` and `/*` never reach it.
 */
const REGEX_MAY_OPEN_AFTER = new Set([
	"",
	"(",
	",",
	"=",
	":",
	"[",
	"!",
	"&",
	"|",
	"?",
	"{",
	"}",
	";",
	"+",
	"-",
	"*",
	"%",
	"~",
	"^",
	"<",
	">",
]);

const isWordChar = (c: string): boolean => /[\p{L}\p{N}_$]/u.test(c);

/**
 * The end index of a quoted string opened at `open`, or `-1` when the quote never closes on that
 * line.
 *
 * **The same-line rule is what keeps an apostrophe in JSX text from swallowing the rest of a file.**
 * `somebody else's entry` opens a `'` that no `'` closes, and a scanner that believed it were a
 * string would read every following line as string body — which is fail-OPEN on a fail-closed gate.
 * A real string literal in this repo is double-quoted (Biome's default `quoteStyle`) and never spans
 * a raw newline, so refusing to open one across a line loses nothing real.
 */
const quoteEnd = (src: string, open: number, quote: string): number => {
	for (let i = open + 1; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "\n") return -1;
		if (c === quote) return i;
	}
	return -1;
};

/** The end index of a regex literal opened at `open`, or `-1` when it does not close on its line. */
const regexEnd = (src: string, open: number): number => {
	let inClass = false;
	for (let i = open + 1; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "\n") return -1;
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) return i;
	}
	return -1;
};

/** 1-based line number of `index`, counted once per call over the prefix. */
const lineAt = (src: string, index: number): number => {
	let line = 1;
	for (let i = 0; i < index; i++) if (src[i] === "\n") line++;
	return line;
};

/**
 * Is the bare word run `[start, end)` an unquoted object key — `ç: "c"`?
 *
 * The test is both sides: the next significant character is `:`, and the previous one opens a member
 * position (`{` or `,`). Requiring both is what keeps JSX text that happens to end in a colon —
 * `<span>kullanıcı:</span>` — a hit.
 */
const isObjectKey = (src: string, start: number, end: number): boolean => {
	let after = end;
	while (after < src.length && /\s/u.test(src[after] ?? "")) after++;
	if (src[after] !== ":") return false;
	let before = start - 1;
	while (before >= 0 && /\s/u.test(src[before] ?? "")) before--;
	const prev = src[before];
	return prev === "{" || prev === ",";
};

/**
 * Every Turkish run in one TS/TSX source, with comments, regex literals and object keys skipped.
 *
 * The scanner classifies comments, strings and regex literals and treats everything left as bare
 * source. In a `.tsx` file under `apps/web/src` that remainder is JSX text or an identifier, which
 * is why `jsx-text` is the honest name for the second arm — an identifier cannot carry a Turkish
 * letter under this repo's English-for-technical rule.
 */
export const scanSource = (src: string): ReadonlyArray<TurkishHit> => {
	const hits: Array<TurkishHit> = [];
	const push = (index: number, kind: HitKind, text: string): void => {
		if (!TURKISH.test(text)) return;
		hits.push({line: lineAt(src, index), kind, excerpt: excerptOf(text)});
	};
	const n = src.length;
	let i = 0;
	let prevSignificant = "";
	/**
	 * One entry per open `${`, holding the brace depth reached inside it. A `}` resumes the template
	 * only at depth 0 — otherwise it closes an object literal or a block written in the hole.
	 */
	const holes: Array<number> = [];
	while (i < n) {
		const c = src[i] as string;
		if (c === "/" && src[i + 1] === "/") {
			while (i < n && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const close = src.indexOf("*/", i + 2);
			i = close === -1 ? n : close + 2;
			continue;
		}
		if (c === '"' || c === "'") {
			const end = quoteEnd(src, i, c);
			if (end !== -1) {
				push(i + 1, "string", src.slice(i + 1, end));
				i = end + 1;
				prevSignificant = c;
				continue;
			}
		}
		if (c === "{" && holes.length > 0) {
			holes[holes.length - 1] = (holes[holes.length - 1] ?? 0) + 1;
			prevSignificant = c;
			i++;
			continue;
		}
		if (c === "}" && holes.length > 0 && (holes[holes.length - 1] ?? 0) > 0) {
			holes[holes.length - 1] = (holes[holes.length - 1] ?? 0) - 1;
			prevSignificant = c;
			i++;
			continue;
		}
		if (c === "`" || (c === "}" && holes.length > 0)) {
			if (c === "}") holes.pop();
			let j = i + 1;
			const start = j;
			for (;;) {
				if (j >= n) break;
				const t = src[j] as string;
				if (t === "\\") {
					j += 2;
					continue;
				}
				if (t === "`") break;
				if (t === "$" && src[j + 1] === "{") {
					holes.push(0);
					break;
				}
				j++;
			}
			push(start, "string", src.slice(start, j));
			i = j >= n ? n : j + (src[j] === "$" ? 2 : 1);
			prevSignificant = "`";
			continue;
		}
		if (c === "/" && REGEX_MAY_OPEN_AFTER.has(prevSignificant)) {
			const end = regexEnd(src, i);
			if (end !== -1) {
				i = end + 1;
				prevSignificant = "/";
				continue;
			}
		}
		if (isWordChar(c)) {
			let j = i;
			while (j < n && isWordChar(src[j] as string)) j++;
			const word = src.slice(i, j);
			if (TURKISH.test(word) && !isObjectKey(src, i, j)) push(i, "jsx-text", word);
			i = j;
			prevSignificant = word[word.length - 1] ?? "";
			continue;
		}
		if (!/\s/u.test(c)) prevSignificant = c;
		i++;
	}
	return hits;
};

/** The root every scanned path sits under. */
export const SCAN_ROOT = "apps/web/src";

/**
 * The two directories the issue exempts wholesale. `i18n/` is the catalog itself — the one place
 * Turkish copy belongs. `lab/` is the atölye exhibit corpus, whose in-exhibit sample content is not
 * a user surface at all (`.glossary/LANGUAGE.md`'s showcase rule).
 */
const EXEMPT_DIRS = [`${SCAN_ROOT}/i18n/`, `${SCAN_ROOT}/lab/`];

/**
 * Is this repo-relative path one the guard judges?
 *
 * Tests are out of scope by the issue's own wording: a `.test.tsx` asserting that a button reads
 * `gönder` is asserting the catalog's output, so forbidding the literal there would forbid the
 * assertion.
 */
export const isInScope = (relPath: string): boolean => {
	if (!relPath.startsWith(`${SCAN_ROOT}/`)) return false;
	if (!relPath.endsWith(".ts") && !relPath.endsWith(".tsx")) return false;
	if (/\.test\.tsx?$/u.test(relPath)) return false;
	return !EXEMPT_DIRS.some((dir) => relPath.startsWith(dir));
};

/** One scanned file, reduced to the facts the decision needs. */
export interface FileScan {
	/** Repo-relative POSIX path — the key an allowance is written against. */
	readonly path: string;
	readonly hits: ReadonlyArray<TurkishHit>;
}

/**
 * A bounded, reasoned exception. `why` is mandatory so nothing is ever exempted silently, and
 * `ceiling` is a count rather than a boolean so the allowance is a ratchet: adding a Turkish literal
 * to an allowed file still reds.
 */
export interface Allowance {
	readonly ceiling: number;
	readonly why: string;
}

/**
 * The allow-list, split by what the two halves mean to a reader.
 *
 * `exempt` is permanent — a wire enum value (`"çaylak"`), a Turkish-alphabet index, a throwaway lab
 * surface. `unmigrated` is debt: copy the migration children did not reach, each entry naming the
 * issue that clears it. Collapsing them into one map would make the debt invisible.
 */
export interface I18nGuardConfig {
	readonly exempt: Readonly<Record<string, Allowance>>;
	readonly unmigrated: Readonly<Record<string, Allowance>>;
}

export interface OverCeiling {
	readonly path: string;
	readonly ceiling: number;
	readonly hits: ReadonlyArray<TurkishHit>;
}

/** An allowance whose file the scan never saw — a config that outlived its subject. */
export interface DeadAllowance {
	readonly bucket: "exempt" | "unmigrated";
	readonly path: string;
}

export type I18nVerdict =
	| {readonly _tag: "Clean"; readonly filesScanned: number; readonly allowed: number}
	| {readonly _tag: "ZeroScope"}
	| {
			readonly _tag: "Violation";
			readonly filesScanned: number;
			readonly over: ReadonlyArray<OverCeiling>;
			readonly dead: ReadonlyArray<DeadAllowance>;
	  };

const allowanceFor = (config: I18nGuardConfig, path: string): Allowance | undefined =>
	config.exempt[path] ?? config.unmigrated[path];

export const judge = (input: {
	readonly files: ReadonlyArray<FileScan>;
	readonly config: I18nGuardConfig;
}): I18nVerdict => {
	const {files, config} = input;
	if (files.length === 0) return {_tag: "ZeroScope"};
	const seen = new Set(files.map((f) => f.path));
	const over: Array<OverCeiling> = [];
	let allowed = 0;
	for (const file of files) {
		const allowance = allowanceFor(config, file.path);
		const ceiling = allowance?.ceiling ?? 0;
		if (allowance !== undefined && file.hits.length > 0) allowed += 1;
		if (file.hits.length > ceiling) over.push({path: file.path, ceiling, hits: file.hits});
	}
	const dead: Array<DeadAllowance> = [
		...Object.keys(config.exempt)
			.filter((p) => !seen.has(p))
			.map((path): DeadAllowance => ({bucket: "exempt", path})),
		...Object.keys(config.unmigrated)
			.filter((p) => !seen.has(p))
			.map((path): DeadAllowance => ({bucket: "unmigrated", path})),
	];
	if (over.length === 0 && dead.length === 0)
		return {_tag: "Clean", filesScanned: files.length, allowed};
	return {_tag: "Violation", filesScanned: files.length, over, dead};
};

const VERB = "guard i18n-guard check";

export const renderReport = (verdict: I18nVerdict): string => {
	if (verdict._tag === "ZeroScope")
		return `${VERB}: scanned zero files under apps/web/src — the scope resolved empty, so a pass would be vacuous. Fail-closed (ADR 0092).\n`;
	if (verdict._tag === "Clean")
		return `${VERB}: clean — ${verdict.filesScanned} file(s) scanned, ${verdict.allowed} carrying an allowed Turkish literal, none over its ceiling.\n`;
	const lines: Array<string> = [
		`${VERB}: Turkish copy outside the i18n catalog (${verdict.filesScanned} file(s) scanned).`,
		"",
	];
	for (const entry of verdict.over) {
		lines.push(`  ${entry.path} — ${entry.hits.length} hit(s), ceiling ${entry.ceiling}:`);
		for (const hit of entry.hits) lines.push(`    L${hit.line} (${hit.kind}): ${hit.excerpt}`);
	}
	if (verdict.over.length > 0) {
		lines.push(
			"",
			'Read the copy through the catalog instead: `const t = useT()` and `t("<surface>.<thing>")`,',
			"with the string added to apps/web/src/i18n/tr/<surface>.ts and its English twin in en/.",
			"See .patterns/i18n-catalog.md and ADR 0347.",
		);
	}
	for (const entry of verdict.dead) {
		lines.push(
			`  ${entry.path} — a \`${entry.bucket}\` allowance names a file this scan never saw. Drop the entry.`,
		);
	}
	return `${lines.join("\n")}\n`;
};

export const annotationsFor = (verdict: I18nVerdict): ReadonlyArray<Annotation> => {
	if (verdict._tag !== "Violation") return [];
	return [
		...verdict.over.flatMap((entry) =>
			entry.hits.map((hit) =>
				atLine(
					"error",
					entry.path,
					hit.line,
					`Turkish copy outside apps/web/src/i18n: ${hit.excerpt}. Fix: move it into i18n/tr/<surface>.ts (plus its en/ twin) and read it with t("<surface>.<thing>") — ADR 0347, .patterns/i18n-catalog.md.`,
				),
			),
		),
		...verdict.dead.map((entry) =>
			atLine(
				"error",
				"apps/web/src/i18n/i18n-guard.config.json",
				1,
				`The \`${entry.bucket}\` allowance for ${entry.path} names a file the scan never saw — drop the entry rather than leave a ratchet nothing holds.`,
			),
		),
	];
};
