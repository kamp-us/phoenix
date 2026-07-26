/**
 * `cli-invocation-guard` core — the pure, IO-free matcher behind
 * `pipeline-cli cli-invocation-guard check <file>…` (#3314).
 *
 * `pipeline-cli` is not on PATH where pipeline agents spawn and never will be (ADR 0207
 * retired PATH-shadowing), so a bare `pipeline-cli <verb>` in a skill dies `command not
 * found` — at a gate step, inside a fail-closed wrapper that converts the miss into a wrong
 * verdict. The canonical resolution and its exit-code taxonomy live once in the formats
 * contract's §CLI; this core is the mechanical enforcement of its one ban.
 *
 * Scoped to what an agent actually RUNS: a `bash`/`sh` fenced block, minus comment-only
 * lines. Prose that merely names a verb ("the `pipeline-cli claim is-mine` verb") is not an
 * invocation and is not flagged — flagging it would make the guard unusable in the very docs
 * that define the rule.
 */

export interface ScanFile {
	readonly file: string;
	readonly content: string;
}

export interface Finding {
	readonly file: string;
	/** 1-based line number of the offending line. */
	readonly line: number;
	/** The offending line, trimmed — enough to locate it without opening the file. */
	readonly text: string;
}

export interface GuardResult {
	readonly findings: ReadonlyArray<Finding>;
	/** Every file path scanned — the scope, emitted before the verdict (§ZS / ADR 0092). */
	readonly scanned: ReadonlyArray<string>;
	/** How many runnable bash/sh fences were scanned across all files — the second scope axis. */
	readonly fenceCount: number;
}

const FENCE = /^\s*(?:```|~~~)\s*(\w*)/;
const RUNNABLE_LANGS = new Set(["bash", "sh", "shell", "zsh"]);

/**
 * Blockquoted fences are runnable too — the skills park half their snippets inside `> ` asides,
 * and an agent copies those the same way. Strip the quote markers before every test, or the whole
 * block goes invisible to the scanner (a silent hole exactly where the fix lives).
 */
const unquote = (line: string): string => line.replace(/^(\s*>)+\s?/, "");

/**
 * A bare invocation: the token `pipeline-cli` followed by whitespace, NOT preceded by a path
 * separator, a word character, or the `$PCLI`-style expansion that resolves it. The
 * lookbehind-free form is a negated character class on the preceding char, so `bin/pipeline-cli`,
 * `packages/pipeline-cli`, `@kampus/pipeline-cli` and `-pipeline-cli` all fall through.
 */
const BARE_INVOCATION = /(^|[^\w./@-])pipeline-cli(\s|$)/;

/** A line that is only a shell comment carries no invocation to run. */
const COMMENT_ONLY = /^\s*#/;

/** Every bare-invocation finding in one file's markdown. */
export const scanFile = (
	file: string,
	content: string,
): {
	readonly findings: ReadonlyArray<Finding>;
	readonly fences: number;
} => {
	const findings: Finding[] = [];
	let fences = 0;
	let openLang: string | null = null;
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const lineText = unquote(lines[i] ?? "");
		const fence = lineText.match(FENCE);
		if (fence !== null) {
			// A fence line either opens a block (capturing its language) or closes the open one.
			// Markdown has no nesting here, so open/close alternate.
			if (openLang === null) {
				const lang = (fence[1] ?? "").toLowerCase();
				openLang = lang;
				if (RUNNABLE_LANGS.has(lang)) fences++;
			} else {
				openLang = null;
			}
			continue;
		}
		if (openLang === null || !RUNNABLE_LANGS.has(openLang)) continue;
		if (COMMENT_ONLY.test(lineText)) continue;
		if (!BARE_INVOCATION.test(lineText)) continue;
		findings.push({file, line: i + 1, text: lineText.trim()});
	}
	return {findings, fences};
};

/** Scan the whole handed-in corpus, returning findings alongside both scope axes. */
export const scanCorpus = (files: ReadonlyArray<ScanFile>): GuardResult => {
	const scanned: string[] = [];
	const findings: Finding[] = [];
	let fenceCount = 0;
	for (const {file, content} of files) {
		scanned.push(file);
		const result = scanFile(file, content);
		findings.push(...result.findings);
		fenceCount += result.fences;
	}
	return {findings, scanned, fenceCount};
};

/**
 * Zero scope = FAIL (§ZS / ADR 0092). Both axes must be non-empty: a corpus with no file, and
 * a corpus whose files contain no runnable fence at all, are equally broken scopes — the second
 * is how a fence-parser regression would otherwise ship as a silent green.
 */
export const isZeroScope = (result: GuardResult): boolean =>
	result.scanned.length === 0 || result.fenceCount === 0;
