/**
 * `@kampus/pipeline-cli` — the `workflow-contract` pure core (#1219).
 *
 * The IO-free derivation behind the Workflow-script contract gate: given a
 * `.claude/workflows/*.js` source string, decide whether it conforms to the
 * Workflow runtime's load shape. `gate.ts` wires this to the filesystem (enumerate
 * the scripts, read each, render the verdict); this file holds the parse so it is
 * unit-testable over plain strings, no disk (the core-in-its-own-file idiom; #855).
 *
 * THE CONTRACT (source-grounded in bug #1217's diagnosis — the lived defect where a
 * `node --check`-valid, `review-code`-correct script was non-launchable). A loadable
 * workflow script is shaped:
 *
 *   - `export const meta = { … }` — a PURE OBJECT LITERAL carrying at least `name`
 *     and `description` (conventionally also `phases`), no computed value;
 *   - a TOP-LEVEL body (module scope, top-level await) that uses `agent()` /
 *     `phase()` / `log()` as INJECTED GLOBALS and reads `args` as a global;
 *   - NO `export default` and no function wrapper — `export default async function
 *     (…)` is *exactly* what the runtime rejects (`SyntaxError: Unexpected keyword
 *     'export'`), even though it is valid ES-module JS. This is the load-breaking
 *     signal, so it is the primary assertion; the `meta` object-literal is the
 *     second. The "body references the injected globals" condition is a softer
 *     heuristic (a conformant body need not reference all four) and is recorded as
 *     documented intent, NOT a brittle must-reference-all rule (#1219 triage note).
 *
 * Robustness over a brittle regex: the source is first MASKED — comments, string
 * literals, and template literals are blanked to spaces (line count preserved) so an
 * `export default` written inside a string or comment, or a `name:` inside a string
 * VALUE, never false-trips the token scan. The same masking idiom as `doc-links`'s
 * `maskCode`, extended to a full single-pass scanner for JS strings/templates.
 */

/** A single contract violation found in a workflow script, with a human reason. */
export interface Violation {
	readonly rule:
		| "export-default"
		| "meta-missing"
		| "meta-not-literal"
		| "meta-keys"
		| "unparseable";
	readonly reason: string;
	/** 1-based source line, when the violation is locatable. */
	readonly line?: number;
}

/** The verdict for one workflow script. */
export interface ScriptVerdict {
	/** Repo-relative path, e.g. `.claude/workflows/drive-issue.js`. */
	readonly file: string;
	readonly violations: ReadonlyArray<Violation>;
}

/** The aggregate verdict over a set of workflow scripts. */
export interface Verdict {
	readonly pass: boolean;
	readonly scripts: ReadonlyArray<ScriptVerdict>;
}

/**
 * Blank every non-code region — line/block comments, single/double-quoted strings,
 * and template literals — to spaces, preserving newlines so 1-based line numbers
 * stay accurate for the surviving code. A single-pass character scanner with a mode
 * stack: a template literal's `${…}` substitution re-enters CODE (so nested
 * templates and interpolated expressions are scanned, not hidden), and its closing
 * `}` returns to the template. Regex literals are NOT specially handled — a `/…/`
 * containing our tokens is implausible in a workflow script, and over-masking a
 * division operator is harmless to the two assertions (an `export default` cannot
 * sit in an expression position, and `meta` is a top-level export).
 */
export const maskNonCode = (src: string): string => {
	const out: string[] = [];
	const n = src.length;
	// Mode stack. The top frame is the active lexical context. A "template" frame
	// remembers the brace depth at which its `${…}` substitution closes.
	type Frame = {kind: "code"} | {kind: "template"; braceDepth: number};
	const stack: Frame[] = [{kind: "code"}];
	// The base code frame is never popped, so the top is always defined.
	const top = (): Frame => stack[stack.length - 1] ?? {kind: "code"};
	let i = 0;
	const push = (ch: string | undefined) => out.push(ch === "\n" ? "\n" : " ");
	while (i < n) {
		const c = src[i];
		const c2 = src[i + 1];
		const frame = top();
		if (frame.kind === "code") {
			// Comments.
			if (c === "/" && c2 === "/") {
				while (i < n && src[i] !== "\n") push(src[i++]);
				continue;
			}
			if (c === "/" && c2 === "*") {
				push(src[i++]);
				push(src[i++]);
				while (i < n && !(src[i] === "*" && src[i + 1] === "/")) push(src[i++]);
				if (i < n) {
					push(src[i++]);
					push(src[i++]);
				}
				continue;
			}
			// String literals.
			if (c === "'" || c === '"') {
				const quote = c;
				push(src[i++]); // opening quote
				while (i < n && src[i] !== quote) {
					if (src[i] === "\\") {
						push(src[i++]);
						if (i < n) push(src[i++]);
						continue;
					}
					if (src[i] === "\n") break; // unterminated; let it resync
					push(src[i++]);
				}
				if (i < n && src[i] === quote) push(src[i++]);
				continue;
			}
			// Template literal open.
			if (c === "`") {
				push(src[i++]);
				stack.push({kind: "template", braceDepth: 0});
				continue;
			}
			// A `}` may close a template substitution (the matching frame below it).
			if (c === "}") {
				const below = stack[stack.length - 2];
				const cur = top();
				if (cur.kind === "code" && below && below.kind === "template") {
					// This code frame is a `${…}` substitution; `}` closes it back to template.
					stack.pop();
					out.push("}"); // the brace itself is code — keep it visible
					i++;
					continue;
				}
				out.push("}");
				i++;
				continue;
			}
			out.push(c ?? "");
			i++;
			continue;
		}
		// frame.kind === "template"
		if (c === "\\") {
			push(src[i++]);
			if (i < n) push(src[i++]);
			continue;
		}
		if (c === "`") {
			push(src[i++]);
			stack.pop(); // close the template
			continue;
		}
		if (c === "$" && c2 === "{") {
			push(src[i++]); // $
			out.push("{"); // brace is code — keep visible for balance scans
			i++;
			stack.push({kind: "code"});
			continue;
		}
		push(src[i++]);
	}
	return out.join("");
};

/** 1-based line number of a string index. */
const lineOf = (text: string, index: number): number => {
	let line = 1;
	for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
	return line;
};

const EXPORT_DEFAULT_RE = /\bexport\s+default\b/;
const META_DECL_RE = /\bexport\s+(?:const|let|var)\s+meta\b/;

/**
 * From a masked source and a start index at the `{` that opens an object literal,
 * return the index just past the matching `}` (balanced), or -1 if unbalanced.
 */
const matchBrace = (masked: string, open: number): number => {
	let depth = 0;
	for (let i = open; i < masked.length; i++) {
		if (masked[i] === "{") depth++;
		else if (masked[i] === "}") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
};

/**
 * Collect the TOP-LEVEL keys of an object literal given its masked body (the text
 * between the outer braces, exclusive). Tracks nesting depth so only depth-0 keys —
 * `ident:` or `"str":` immediately followed by a colon — are returned, never a key
 * of a nested object. String VALUES are already masked to spaces, so a `"name: x"`
 * value can't masquerade as a key.
 */
export const topLevelKeys = (innerMasked: string): ReadonlyArray<string> => {
	const keys: string[] = [];
	let depth = 0;
	const keyRe = /([A-Za-z_$][\w$]*)\s*:/g;
	// We scan char by char to track depth, and at depth 0 match an identifier:key.
	let i = 0;
	const n = innerMasked.length;
	while (i < n) {
		const ch = innerMasked[i] ?? "";
		if (ch === "{" || ch === "[" || ch === "(") {
			depth++;
			i++;
			continue;
		}
		if (ch === "}" || ch === "]" || ch === ")") {
			depth--;
			i++;
			continue;
		}
		if (depth === 0 && /[A-Za-z_$]/.test(ch)) {
			keyRe.lastIndex = i;
			const m = keyRe.exec(innerMasked);
			if (m && m.index === i && m[1]) {
				keys.push(m[1]);
				i = keyRe.lastIndex;
				continue;
			}
		}
		i++;
	}
	return keys;
};

const REQUIRED_META_KEYS = ["name", "description"] as const;

/**
 * Judge a single workflow script against the runtime contract. Returns every
 * violation found (empty ⇒ conformant). The two high-value assertions:
 *
 *   1. NO `export default` (the #1217 load-breaker) — the primary reject.
 *   2. `export const meta = { … }` present, an object literal, carrying at least
 *      `name` and `description` at the top level.
 *
 * Both run over the masked source so a token inside a string/comment can't trip
 * either assertion.
 */
export const judgeScript = (file: string, source: string): ScriptVerdict => {
	const violations: Violation[] = [];
	let masked: string;
	try {
		masked = maskNonCode(source);
	} catch (cause) {
		// A masking crash means the source is pathological — fail closed (ADR 0092).
		return {
			file,
			violations: [
				{rule: "unparseable", reason: `could not scan the script source (${String(cause)})`},
			],
		};
	}

	// (1) export default — the load-breaking wrapper shape.
	const ed = EXPORT_DEFAULT_RE.exec(masked);
	if (ed) {
		violations.push({
			rule: "export-default",
			reason:
				"contains `export default` — the Workflow runtime rejects a default-export / function-wrapper script (`SyntaxError: Unexpected keyword 'export'`, bug #1217). Author the script as `export const meta = {…}` plus a top-level body.",
			line: lineOf(masked, ed.index),
		});
	}

	// (2) export const meta = { … } object literal with name + description.
	const decl = META_DECL_RE.exec(masked);
	if (!decl) {
		violations.push({
			rule: "meta-missing",
			reason:
				"no `export const meta = {…}` declaration — the runtime reads `meta` for the workflow's name/description/phases.",
		});
	} else {
		// Find the `=` then the first non-space token; it must be `{`.
		let j = decl.index + decl[0].length;
		while (j < masked.length && masked[j] !== "=" && masked[j] !== "\n") j++;
		// Skip the `=` and whitespace to the first significant char.
		let k = j + 1;
		while (k < masked.length && /\s/.test(masked[k] ?? "")) k++;
		if (masked[j] !== "=" || masked[k] !== "{") {
			violations.push({
				rule: "meta-not-literal",
				reason:
					"`export const meta` is not assigned a plain object literal (`= {…}`) — `meta` must be a pure literal, not a computed value or reference.",
				line: lineOf(masked, decl.index),
			});
		} else {
			const end = matchBrace(masked, k);
			if (end === -1) {
				violations.push({
					rule: "meta-not-literal",
					reason: "the `meta` object literal has unbalanced braces — could not parse it.",
					line: lineOf(masked, decl.index),
				});
			} else {
				const inner = masked.slice(k + 1, end - 1);
				const keys = topLevelKeys(inner);
				const missing = REQUIRED_META_KEYS.filter((req) => !keys.includes(req));
				if (missing.length > 0) {
					violations.push({
						rule: "meta-keys",
						reason: `the \`meta\` object literal is missing required key(s): ${missing.join(", ")} (it must carry at least \`name\` and \`description\`).`,
						line: lineOf(masked, decl.index),
					});
				}
			}
		}
	}

	return {file, violations};
};

/** Aggregate per-script verdicts: pass iff every script is violation-free. */
export const judge = (scripts: ReadonlyArray<ScriptVerdict>): Verdict => ({
	pass: scripts.every((s) => s.violations.length === 0),
	scripts,
});

/** Render a human report for a verdict (passed verbatim to the gate's stderr). */
export const renderReport = (verdict: Verdict): string => {
	if (verdict.pass) {
		const n = verdict.scripts.length;
		return `workflow-contract: ${n} workflow script${n === 1 ? "" : "s"} conform to the runtime contract`;
	}
	const lines: string[] = ["workflow-contract: contract violation(s) found:"];
	for (const s of verdict.scripts) {
		for (const v of s.violations) {
			const at = v.line ? `${s.file}:${v.line}` : s.file;
			lines.push(`  ${at} [${v.rule}] ${v.reason}`);
		}
	}
	return lines.join("\n");
};
