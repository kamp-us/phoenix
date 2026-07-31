/**
 * `cli-invocation-guard` core — the pure, IO-free matcher behind
 * `pipeline-cli cli-invocation-guard check <file>…` (#3314).
 *
 * Two non-canonical forms are banned, for the same reason: neither's failure is
 * distinguishable from a verb result at the call site. A bare `pipeline-cli <verb>` is not on
 * PATH where pipeline agents spawn and never will be (ADR 0207 retired PATH-shadowing), so it
 * dies `command not found`; a cwd-relative `node …/pipeline-cli/src/bin.ts <verb>` resolves
 * only from the repo root, so it dies `Cannot find module` anywhere else. Both land at a gate
 * step, inside a fail-closed wrapper that converts the miss into a wrong verdict. The canonical
 * resolution and its exit-code taxonomy live once in the formats contract's §CLI; this core is
 * the mechanical enforcement of its bans (#3314, #4236).
 *
 * Scoped to what an agent actually RUNS: a `bash`/`sh` fenced block, minus comment-only
 * lines. Prose that merely names a verb ("the `pipeline-cli claim is-mine` verb") is not an
 * invocation and is not flagged — flagging it would make the guard unusable in the very docs
 * that define the rule.
 *
 * The corpus is markdown AND shell: a `.sh` file is **one implicit runnable fence** with no
 * delimiters, scanned whole. Without that reach, every extraction of fenced shell into a
 * per-skill `scripts/*.sh` takes its call sites off the scan while the guard keeps exiting 0
 * (#4486, the #4470 class; the unit-of-scan answer follows #4448's consumer precedent).
 *
 * Detection is corpus-wide by design; ATTRIBUTION is what `attribute` below adds (#4250). The
 * scan still sees every violation anywhere in the tree — only the verdict is narrowed, on the
 * PR leg, to the ones this head introduced.
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
	/** Runnable bash/sh fences found in the **markdown** surface — that surface's scope axis. */
	readonly fenceCount: number;
	/** Shell files scanned, each one implicit runnable fence — the **shell** surface's scope axis. */
	readonly shellFileCount: number;
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

/**
 * The second non-canonical form: running the CLI's entrypoint directly through `node` at a
 * **cwd-relative** path. It resolves only from the repo root and only in this repo, so from a
 * nested app dir — the dir sessions launch in — it dies `Cannot find module` with **exit 1 and
 * empty stdout**. That is byte-identical to the clean answer several call sites consume
 * (`guard-content-probe`'s not-guard-touching exit 1; `intake-dedup` / `split-guard`'s empty
 * stdout = "nothing found"), so a resolution failure launders into a permissive verdict —
 * a fail-open on a gate, not a style nit (#4236). §CLI's exit-code taxonomy covers it.
 */
const NODE_ENTRYPOINT_INVOCATION = /\bnode\s+\S*pipeline-cli\/src\/bin\.ts(\s|$)/;

/** A line that is only a shell comment carries no invocation to run. */
const COMMENT_ONLY = /^\s*#/;

/**
 * A shell file is runnable in its entirety, so it is scanned as one implicit `bash` fence that
 * opens at line 1 and never closes. Fence delimiters are therefore not interpreted at all inside
 * one: the extracted gate scripts emit markdown from heredocs (verdict comments, PR bodies), and
 * honouring a ``` line there would close the implicit fence and blind the rest of the file — a
 * silent hole in exactly the direction this guard exists to close.
 */
const isShellFile = (file: string): boolean => file.endsWith(".sh");

/** Every non-canonical-invocation finding in one corpus file — markdown or shell. */
export const scanFile = (
	file: string,
	content: string,
): {
	readonly findings: ReadonlyArray<Finding>;
	readonly fences: number;
} => {
	const findings: Finding[] = [];
	const shell = isShellFile(file);
	let fences = shell ? 1 : 0;
	let openLang: string | null = shell ? "bash" : null;
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const lineText = unquote(lines[i] ?? "");
		const fence = shell ? null : lineText.match(FENCE);
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
		if (!BARE_INVOCATION.test(lineText) && !NODE_ENTRYPOINT_INVOCATION.test(lineText)) continue;
		findings.push({file, line: i + 1, text: lineText.trim()});
	}
	return {findings, fences};
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
		if (isShellFile(file)) shellFileCount++;
		else fenceCount += result.fences;
	}
	return {findings, scanned, fenceCount, shellFileCount};
};

/**
 * Zero scope = FAIL (§ZS / ADR 0092), and the floor is **per surface**: no file at all, no
 * runnable fence in the markdown surface, or no shell file in the shell surface. A single
 * total would let the markdown surface's hundreds of fences satisfy the floor while the `.sh`
 * leg of the corpus `find` silently contributed nothing — which is the same silent-green the
 * guard's whole widening exists to remove, relocated one layer down (#4486).
 */
export const isZeroScope = (result: GuardResult): boolean =>
	result.scanned.length === 0 || result.fenceCount === 0 || result.shellFileCount === 0;

/** Whether a head finding was already there at the merge-base, or this head introduced it. */
export type Attribution = "new" | "pre-existing";

export interface AttributedFinding extends Finding {
	readonly attribution: Attribution;
}

/**
 * A finding's identity for baseline comparison: the file plus the exact offending text, and
 * deliberately NOT the line number — an unrelated edit above shifts every line below it, and a
 * shifted line is the same pre-existing violation, not a new one. Keying on the file (rather
 * than text alone) keeps a violation MOVED into another file attributable, which is the strict
 * direction.
 */
const findingKey = (f: Finding): string => `${f.file}\t${f.text}`;

/**
 * Classify each head finding against the merge-base's findings.
 *
 * The diff is a MULTISET, not a set: a file carrying one offending line at the base and two at
 * head introduced one, and the second must not hide behind the first. That is the property
 * that keeps this from degenerating into "any file that was ever dirty is forever exempt".
 */
export const attribute = (
	head: ReadonlyArray<Finding>,
	baseline: ReadonlyArray<Finding>,
): ReadonlyArray<AttributedFinding> => {
	const unconsumed = new Map<string, number>();
	for (const f of baseline) {
		const key = findingKey(f);
		unconsumed.set(key, (unconsumed.get(key) ?? 0) + 1);
	}
	return head.map((f) => {
		const key = findingKey(f);
		const left = unconsumed.get(key) ?? 0;
		if (left === 0) return {...f, attribution: "new"};
		unconsumed.set(key, left - 1);
		return {...f, attribution: "pre-existing"};
	});
};

/**
 * A baseline is trustworthy only if the base-side scan actually looked at something. A zero
 * scope on ANY axis — including the `.sh` surface (#4486) — means the base scan is broken, and a
 * broken base scan must never read as "nothing was pre-existing": that inverts to "everything is
 * newly introduced" on one leg and, if the emptiness came from the other direction, would mask
 * real new violations. Callers red on false (ADR 0092 §ZS, extended to the baseline input —
 * #4250).
 */
export const isUsableBaseline = (baseline: GuardResult): boolean => !isZeroScope(baseline);

const isFinding = (value: unknown): value is Finding => {
	if (typeof value !== "object" || value === null) return false;
	const f = value as Record<string, unknown>;
	return typeof f.file === "string" && typeof f.line === "number" && typeof f.text === "string";
};

/**
 * Parse a `baseline`-emitted manifest back into a `GuardResult`. `null` = unusable, which reds.
 *
 * Every scope axis is asserted present AND numeric, `shellFileCount` included: a manifest written
 * by a build predating the `.sh` surface (#4486) omits the field, it reads back `undefined`, and
 * `isZeroScope`'s `=== 0` test does not catch that — so a zero-shell-scope baseline would sail
 * through as usable. Only reachable under version skew between the base-side `baseline` and the
 * head-side `check`, but "no pre-existing violations" is the wrong direction to be wrong in.
 */
export const parseBaseline = (raw: string): GuardResult | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const {findings, scanned, fenceCount, shellFileCount} = parsed as Record<string, unknown>;
	if (!Array.isArray(findings) || !findings.every(isFinding)) return null;
	if (!Array.isArray(scanned) || !scanned.every((s) => typeof s === "string")) return null;
	if (typeof fenceCount !== "number") return null;
	if (typeof shellFileCount !== "number") return null;
	return {findings, scanned, fenceCount, shellFileCount};
};
