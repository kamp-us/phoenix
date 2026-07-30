/**
 * `trap-status-guard` core — the pure, IO-free matcher behind
 * `pipeline-cli trap-status-guard check <file>…` (#4479).
 *
 * One banned co-occurrence, inside a single runnable shell unit: **`errexit` enabled together
 * with an `EXIT` trap**. On bash 3.2 — the interpreter every local macOS run gets through
 * `#!/usr/bin/env bash` — a `set -u` unbound-variable abort under `-e` reaches the `EXIT` trap
 * with `$?` already reset to 0, so a cleanup trap ending in a succeeding command (`rm -rf
 * "$tmp"`) makes the script exit **0**. A guard that aborted on an unbound variable therefore
 * reports success on a path it never evaluated — the worst failure mode available to a gate.
 *
 * Measured on `GNU bash 3.2.57(1)-release`, and the measurement is the reason the rule is
 * co-occurrence rather than trap-shape: without `-e` the abort's status survives the same
 * cleanup trap (exit 1, fail-closed), and *with* `-e` the widely-suggested status-preserving
 * trap (`trap 'rc=$?; rm -rf "$tmp"; exit $rc' EXIT`) still exits 0, because `$?` is already 0
 * when the trap runs. `-e` is the discriminator; the trap body is not. The full matrix and the
 * bash ≥ 4 caveat live in `.patterns/skill-script-shell-shape.md`.
 *
 * Scoped to what an agent actually RUNS, following `cli-invocation-guard`'s unit-of-scan
 * precedent (#4486): a `.sh` file is one implicit runnable unit scanned whole, and a `.md`
 * contributes one unit per runnable `bash`/`sh` fence. The co-occurrence is judged **per unit**,
 * so a doc that mentions `set -euo pipefail` in one fence and a trap in another is not a
 * finding, while a fence an agent could copy wholesale is.
 */

export interface ScanFile {
	readonly file: string;
	readonly content: string;
}

/** One banned co-occurrence, with both halves located so a reader can open the file once. */
export interface Finding {
	readonly file: string;
	/** 1-based line of the `set` that enabled `errexit`. */
	readonly errexitLine: number;
	readonly errexitText: string;
	/** 1-based line of the `trap … EXIT` install. */
	readonly trapLine: number;
	readonly trapText: string;
}

export interface GuardResult {
	readonly findings: ReadonlyArray<Finding>;
	/** Every file path scanned — the scope, emitted before the verdict (§ZS / ADR 0092). */
	readonly scanned: ReadonlyArray<string>;
	/** Runnable bash/sh fences found in the **markdown** surface — that surface's scope axis. */
	readonly fenceCount: number;
	/** Shell files scanned, each one implicit runnable unit — the **shell** surface's scope axis. */
	readonly shellFileCount: number;
}

const FENCE = /^\s*(?:```|~~~)\s*(\w*)/;
const RUNNABLE_LANGS = new Set(["bash", "sh", "shell", "zsh"]);

/** Blockquoted fences are runnable too — an agent copies a `> `-prefixed snippet the same way. */
const unquote = (line: string): string => line.replace(/^(\s*>)+\s?/, "");

/** A line that is only a shell comment carries nothing to run. */
const COMMENT_ONLY = /^\s*#/;

/**
 * Does this `set` turn `errexit` ON? Parsed rather than pattern-matched, because the flag can
 * arrive three ways (`-e`, clustered in `-euo`, or long as `-o errexit`) and `+e`/`+o errexit`
 * turn it back OFF — a regex that only looks for the letter `e` reads a disable as an enable.
 */
export const enablesErrexit = (line: string): boolean => {
	const tokens = line
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);
	if (tokens[0] !== "set") return false;
	let on = false;
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i] ?? "";
		if (token === "-o" || token === "+o") {
			if ((tokens[i + 1] ?? "") === "errexit") on = token === "-o";
			i++;
			continue;
		}
		if (/^[-+][a-zA-Z]+$/.test(token) && token.includes("e")) on = token.startsWith("-");
	}
	return on;
};

/**
 * Does this line INSTALL an `EXIT` trap? `trap - EXIT` and `trap -- - EXIT` reset the trap to
 * the default rather than installing a handler, so they carry no status-swallowing body and are
 * not the shape. bash accepts the signal name in either case, hence the case-insensitive match.
 */
export const installsExitTrap = (line: string): boolean => {
	if (!/(?:^|[;&|]|\bthen\b|\bdo\b|\{)\s*trap\b/.test(line)) return false;
	if (!/\btrap\b[^#]*\bexit\b/i.test(line)) return false;
	return !/\btrap\s+(?:--\s+)?-\s/.test(line);
};

interface Unit {
	/** 1-based line numbers of every line inside this runnable unit, with its text. */
	readonly lines: ReadonlyArray<readonly [number, string]>;
}

/**
 * Split one corpus file into its runnable shell units. A `.sh` is a single unit opening at line
 * 1 and never closing — fence delimiters are NOT interpreted inside one, because the extracted
 * gate scripts emit markdown from heredocs and honouring a ``` there would blind the rest of the
 * file (the #4486 reasoning, same conclusion).
 */
const units = (
	file: string,
	content: string,
): {readonly units: ReadonlyArray<Unit>; readonly fences: number} => {
	const lines = content.split("\n");
	if (file.endsWith(".sh")) {
		return {
			units: [{lines: lines.map((text, i) => [i + 1, unquote(text)] as const)}],
			fences: 0,
		};
	}
	const found: Unit[] = [];
	let open: Array<readonly [number, string]> | null = null;
	let openLang: string | null = null;
	let fences = 0;
	for (let i = 0; i < lines.length; i++) {
		const text = unquote(lines[i] ?? "");
		const fence = text.match(FENCE);
		if (fence !== null) {
			if (openLang === null) {
				openLang = (fence[1] ?? "").toLowerCase();
				if (RUNNABLE_LANGS.has(openLang)) {
					fences++;
					open = [];
				}
			} else {
				if (open !== null) found.push({lines: open});
				open = null;
				openLang = null;
			}
			continue;
		}
		if (open !== null) open.push([i + 1, text]);
	}
	// An unterminated runnable fence still ran as far as the reader copied it — keep it in scope.
	if (open !== null) found.push({lines: open});
	return {units: found, fences};
};

/** Every banned co-occurrence in one corpus file — markdown or shell. */
export const scanFile = (
	file: string,
	content: string,
): {readonly findings: ReadonlyArray<Finding>; readonly fences: number} => {
	const findings: Finding[] = [];
	const split = units(file, content);
	for (const unit of split.units) {
		let errexit: readonly [number, string] | null = null;
		let trap: readonly [number, string] | null = null;
		for (const [lineNo, text] of unit.lines) {
			if (COMMENT_ONLY.test(text)) continue;
			if (errexit === null && enablesErrexit(text)) errexit = [lineNo, text];
			if (trap === null && installsExitTrap(text)) trap = [lineNo, text];
		}
		if (errexit === null || trap === null) continue;
		findings.push({
			file,
			errexitLine: errexit[0],
			errexitText: errexit[1].trim(),
			trapLine: trap[0],
			trapText: trap[1].trim(),
		});
	}
	return {findings, fences: split.fences};
};

/** Scan the whole handed-in corpus, returning findings alongside both scope axes. */
export const scanCorpus = (files: ReadonlyArray<ScanFile>): GuardResult => {
	const scanned: string[] = [];
	const findings: Finding[] = [];
	let fenceCount = 0;
	let shellFileCount = 0;
	for (const {file, content} of files) {
		scanned.push(file);
		const result = scanFile(file, content);
		findings.push(...result.findings);
		if (file.endsWith(".sh")) shellFileCount++;
		else fenceCount += result.fences;
	}
	return {findings, scanned, fenceCount, shellFileCount};
};

/**
 * Zero scope on ANY axis is fail-closed (ADR 0092): a run that scanned no file, resolved no
 * runnable markdown fence, or saw no shell file has not cleared the surface it reports on.
 */
export const isZeroScope = (result: GuardResult): boolean =>
	result.scanned.length === 0 || result.fenceCount === 0 || result.shellFileCount === 0;
