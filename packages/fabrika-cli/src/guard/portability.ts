/**
 * `portability-guard`'s pure half — is there a reference in fabrika's own text that resolves only in
 * the repository fabrika grew up in?
 *
 * fabrika installs into repositories that are not its home. Every issue number, decision-record
 * number, decision-corpus link and product name left in a skill, a contract or a docblock is a
 * pointer an adopter cannot follow: the exit-code rationale names a ticket they cannot open and the
 * step names a product they do not have. Nothing else in the corpus catches one, and every lane that
 * edits a skill adds more.
 *
 * The five matchers below are the whole rule. Three things are deliberately not hits: a markdown
 * heading (`#` with no digits behind it), a hex colour (`#fff`, `#1a1a1a` — a colour carries letters
 * or too few digits to be a ticket), and a ticket number that is test *data* — the subject under
 * test in a `*.test.ts` string literal, or anything under a fixtures directory, where the number is
 * the input rather than a claim about the world.
 *
 * Scope, the fail-closed floor and the allow-list live at the IO boundary in `./portability-verb.ts`;
 * this module never touches disk and never decides what a scan covered.
 */

import {type Annotation, atLine} from "./annotate.ts";

/** Which of the five rules a hit broke — the report groups on it and a test names it. */
export type PatternId = "issue" | "decision-number" | "decision-link" | "url" | "repo-name";

export interface Hit {
	/** 1-based, so it addresses an editor and a CI annotation directly. */
	readonly line: number;
	readonly pattern: PatternId;
	/** The exact text that matched — what the report shows. */
	readonly matched: string;
}

export interface FileScan {
	readonly path: string;
	readonly hits: ReadonlyArray<Hit>;
}

/** A per-file permanent carve-out. `ceiling` is a count, so one more hit in the file still reds. */
export interface Allowance {
	readonly ceiling: number;
	readonly why: string;
}

/**
 * One sweep unit's floor: the hit count under `paths` at the guard's landing, plus the reason.
 *
 * Keyed per unit rather than per file so that parallel sweeps each edit their own row instead of one
 * file's neighbouring lines.
 */
export interface Unit extends Allowance {
	/** Repo-relative path prefixes this unit owns. Longest prefix wins, so a catch-all may be a root. */
	readonly paths: ReadonlyArray<string>;
}

export interface PortabilityConfig {
	readonly exempt: Readonly<Record<string, Allowance>>;
	readonly unmigrated: Readonly<Record<string, Unit>>;
}

/** The two trees fabrika ships. Everything under them has to read the same in any repository. */
export const SCAN_ROOTS = ["claude-plugins/fabrika", "packages/fabrika-cli/src"] as const;

/** Text this guard can read. Anything else in the trees is bytes it would only guess at. */
const TEXT_EXTENSIONS = [
	".md",
	".ts",
	".tsx",
	".js",
	".mjs",
	".json",
	".jsonc",
	".yml",
	".yaml",
	".txt",
	".sh",
] as const;

export const isTextFile = (path: string): boolean =>
	TEXT_EXTENSIONS.some((extension) => path.endsWith(extension));

/**
 * The guard's own files, which cannot be scanned by it: a guard must spell out what it forbids, so
 * every pattern below is a literal example of the thing.
 *
 * Per-file by suffix, never a directory — a `src/guard/`-wide exemption would silently drop every
 * other guard from the scan.
 */
const SELF_EXEMPT_SUFFIXES = [
	"/src/guard/portability.ts",
	"/src/guard/portability-verb.ts",
	"/src/guard/portability.unit.test.ts",
	"/src/guard/portability-verb.unit.test.ts",
	"/src/guard/portability.golden.test.ts",
] as const;

export const selfExemptSuffixes = (): ReadonlyArray<string> => SELF_EXEMPT_SUFFIXES;

const normalize = (path: string): string => `/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`;

export const isSelfExempt = (path: string): boolean => {
	const p = normalize(path);
	return SELF_EXEMPT_SUFFIXES.some((suffix) => p.endsWith(suffix));
};

export const isInScope = (path: string): boolean => {
	const p = path.replace(/\\/g, "/");
	if (isSelfExempt(p)) return false;
	if (!isTextFile(p)) return false;
	return SCAN_ROOTS.some((root) => p === root || p.startsWith(`${root}/`));
};

/**
 * A ticket number: `#` and two to six digits, ending on a non-word character.
 *
 * Two digits minimum keeps `#1` in a sentence out; the trailing word boundary is what leaves a hex
 * colour alone, because `#1a1a1a` puts a letter where the boundary has to be. A markdown heading
 * needs no rule at all — `## What` carries no digits.
 */
const ISSUE = /#\d{2,6}\b/g;

/** A decision record by number, in the bare and the linked spelling alike. */
const DECISION_NUMBER = /\bADRs?[\s-]+\[?\d{3,4}\b/g;

/** A path into a decision corpus — a directory only the repository that keeps it can resolve. */
const DECISION_LINK = /\.decisions\//g;

/** A hosted issue or pull-request URL, whoever owns the repository it names. */
const URL_REF = /github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\//g;

const REASONS: Readonly<Record<PatternId, string>> = {
	issue: "an issue or pull-request number — it resolves only in the repository it was filed in",
	"decision-number":
		"a decision-record number — the record sits in one repository's own corpus, and the number means something else in the next one",
	"decision-link": "a path into one repository's decision corpus",
	url: "a URL into one repository's issues or pull requests",
	"repo-name": "a name this repository declared as its own under `portability.repoNames`",
};

export const reasonFor = (pattern: PatternId): string => REASONS[pattern];

/** A declared repo name, matched whole and case-insensitively wherever it is not part of a word. */
const repoNamePattern = (name: string): RegExp =>
	new RegExp(
		`(?<![\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`,
		"giu",
	);

const isFixtureFile = (path: string): boolean =>
	/(?:^|\/)(?:__fixtures__|fixtures)\//.test(path.replace(/\\/g, "/"));

const isTestFile = (path: string): boolean => path.replace(/\\/g, "/").endsWith(".test.ts");

/**
 * The `[start, end)` ranges of one line that sit inside a quoted or templated string.
 *
 * Same-line only: a quote that never closes on its line opens nothing, so an apostrophe in prose
 * cannot swallow the rest of the file — which on a fail-closed gate would be fail-open.
 */
const stringSpans = (line: string): ReadonlyArray<readonly [number, number]> => {
	const spans: Array<readonly [number, number]> = [];
	for (let i = 0; i < line.length; i++) {
		const quote = line[i];
		if (quote !== '"' && quote !== "'" && quote !== "`") continue;
		let end = -1;
		for (let j = i + 1; j < line.length; j++) {
			if (line[j] === "\\") {
				j++;
				continue;
			}
			if (line[j] === quote) {
				end = j;
				break;
			}
		}
		if (end === -1) continue;
		spans.push([i + 1, end]);
		i = end;
	}
	return spans;
};

const within = (
	spans: ReadonlyArray<readonly [number, number]>,
	index: number,
	length: number,
): boolean => spans.some(([start, end]) => index >= start && index + length <= end);

/**
 * Is this ticket number data rather than a claim? A fixtures directory holds nothing but data, and
 * inside a test a quoted number is the input the assertion is written against.
 */
const isTicketData = (path: string, line: string, index: number, length: number): boolean => {
	if (isFixtureFile(path)) return true;
	if (!isTestFile(path)) return false;
	return within(stringSpans(line), index, length);
};

/** Every repo-bound reference in one file's text. */
export const scanFile = (
	path: string,
	content: string,
	repoNames: ReadonlyArray<string>,
): ReadonlyArray<Hit> => {
	if (isSelfExempt(path)) return [];
	const matchers: Array<readonly [PatternId, RegExp]> = [
		["issue", ISSUE],
		["decision-number", DECISION_NUMBER],
		["decision-link", DECISION_LINK],
		["url", URL_REF],
		...repoNames.map((name) => ["repo-name", repoNamePattern(name)] as const),
	];
	const hits: Array<Hit> = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i] ?? "";
		for (const [pattern, regex] of matchers) {
			regex.lastIndex = 0;
			for (const match of text.matchAll(regex)) {
				const index = match.index ?? 0;
				if (pattern === "issue" && isTicketData(path, text, index, match[0].length)) continue;
				hits.push({line: i + 1, pattern, matched: match[0]});
			}
		}
	}
	return hits.sort((a, b) => a.line - b.line);
};

/** A row of the allow-list judged against what the scan actually found under it. */
export interface RowVerdict {
	readonly key: string;
	readonly bucket: "exempt" | "unmigrated";
	readonly ceiling: number;
	readonly count: number;
	readonly files: ReadonlyArray<FileScan>;
}

export type Verdict =
	| {readonly _tag: "Clean"; readonly filesScanned: number; readonly allowed: number}
	| {readonly _tag: "ZeroScope"; readonly reason: string}
	| {
			readonly _tag: "Violation";
			readonly filesScanned: number;
			/** Files carrying a reference that no row of the allow-list covers. */
			readonly unlisted: ReadonlyArray<FileScan>;
			/** Rows the scan found more references under than their ceiling allows. */
			readonly over: ReadonlyArray<RowVerdict>;
			/** Floor rows whose ceiling now sits above the count — the floor only shrinks. */
			readonly stale: ReadonlyArray<RowVerdict>;
	  };

/** The unit owning a path: the longest declared prefix, so a catch-all row may name a whole root. */
const unitFor = (config: PortabilityConfig, path: string): string | null => {
	let owner: string | null = null;
	let length = -1;
	for (const [key, unit] of Object.entries(config.unmigrated)) {
		for (const prefix of unit.paths) {
			const covers = path === prefix || path.startsWith(`${prefix.replace(/\/$/, "")}/`);
			if (covers && prefix.length > length) {
				owner = key;
				length = prefix.length;
			}
		}
	}
	return owner;
};

export interface JudgeInput {
	readonly files: ReadonlyArray<FileScan>;
	readonly config: PortabilityConfig;
}

/**
 * The scan against the allow-list.
 *
 * The two buckets differ in one way and it is the point. `exempt` is permanent, so its ceiling is a
 * cap: fewer references than declared is fine. `unmigrated` is the floor a sweep pays down, so its
 * ceiling has to *equal* the count — a ceiling left above what the tree carries is a tolerance the
 * next lane could spend, which is how a ratchet stops ratcheting.
 */
export const judge = ({files, config}: JudgeInput): Verdict => {
	if (files.length === 0) {
		return {
			_tag: "ZeroScope",
			reason: "the scan covered zero files, so a clean verdict would rest on nothing",
		};
	}
	const rows = new Map<string, RowVerdict>();
	const row = (key: string, bucket: "exempt" | "unmigrated", ceiling: number): RowVerdict => {
		const existing = rows.get(key);
		if (existing !== undefined) return existing;
		const fresh: RowVerdict = {key, bucket, ceiling, count: 0, files: []};
		rows.set(key, fresh);
		return fresh;
	};
	for (const [key, allowance] of Object.entries(config.exempt))
		row(key, "exempt", allowance.ceiling);
	for (const [key, unit] of Object.entries(config.unmigrated)) row(key, "unmigrated", unit.ceiling);

	const unlisted: Array<FileScan> = [];
	for (const file of files) {
		if (file.hits.length === 0) continue;
		const exempt = config.exempt[file.path];
		const key = exempt !== undefined ? file.path : unitFor(config, file.path);
		if (key === null) {
			unlisted.push(file);
			continue;
		}
		const current = rows.get(key);
		if (current === undefined) {
			unlisted.push(file);
			continue;
		}
		rows.set(key, {
			...current,
			count: current.count + file.hits.length,
			files: [...current.files, file],
		});
	}
	const judged = [...rows.values()];
	const over = judged.filter((r) => r.count > r.ceiling);
	const stale = judged.filter((r) => r.bucket === "unmigrated" && r.count < r.ceiling);
	if (unlisted.length === 0 && over.length === 0 && stale.length === 0) {
		return {
			_tag: "Clean",
			filesScanned: files.length,
			allowed: judged.reduce((sum, r) => sum + r.count, 0),
		};
	}
	return {_tag: "Violation", filesScanned: files.length, unlisted, over, stale};
};

const HIT_CAP = 20;

const hitLines = (file: FileScan): ReadonlyArray<string> =>
	file.hits
		.slice(0, HIT_CAP)
		.map((hit) => `    ${file.path}:${hit.line}: ${hit.matched} — ${reasonFor(hit.pattern)}`)
		.concat(
			file.hits.length > HIT_CAP
				? [`    … and ${file.hits.length - HIT_CAP} more in this file`]
				: [],
		);

export const renderReport = (verb: string, verdict: Verdict): string => {
	if (verdict._tag === "Clean") {
		return `${verb}: clean — ${verdict.filesScanned} file(s) scanned, ${verdict.allowed} reference(s) under a declared ceiling and none above it.\n`;
	}
	if (verdict._tag === "ZeroScope") {
		return `${verb}: ${verdict.reason}. Fail-closed.\n`;
	}
	const lines: Array<string> = [
		`${verb}: ${verdict.filesScanned} file(s) scanned; the corpus fabrika ships must read the same in any repository, and it does not here:`,
	];
	if (verdict.unlisted.length > 0) {
		lines.push(
			`  ${verdict.unlisted.length} file(s) carry a reference no allow-list row covers — rewrite the sentence so it stands alone, move the fact into the repository's own config or docs, or drop it:`,
		);
		for (const file of verdict.unlisted) lines.push(...hitLines(file));
	}
	for (const entry of verdict.over) {
		lines.push(
			`  ${entry.bucket} row \`${entry.key}\` carries ${entry.count} reference(s) over a ceiling of ${entry.ceiling} — a ceiling is a count, so a new reference under a listed row still reds:`,
		);
		for (const file of entry.files) lines.push(...hitLines(file));
	}
	for (const entry of verdict.stale) {
		lines.push(
			`  unmigrated row \`${entry.key}\` declares a ceiling of ${entry.ceiling} over ${entry.count} reference(s) — the floor only shrinks, so lower the ceiling to ${entry.count}${entry.count === 0 ? " or delete the row" : ""}.`,
		);
	}
	return `${lines.join("\n")}\n`;
};

export const annotationsFor = (verdict: Verdict): ReadonlyArray<Annotation> => {
	if (verdict._tag !== "Violation") return [];
	const files = [...verdict.unlisted, ...verdict.over.flatMap((entry) => entry.files)];
	return files.flatMap((file) =>
		file.hits
			.slice(0, HIT_CAP)
			.map((hit) => atLine("error", file.path, hit.line, reasonFor(hit.pattern))),
	);
};
