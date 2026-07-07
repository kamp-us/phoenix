/**
 * `codeql-lint` pure core (issue #2261) — a deterministic, IO-free author-time
 * approximation of the two COMMON CodeQL findings that keep blocking net-new-artifact
 * PRs at ship (never at `review-code`, which does not run CodeQL). It is NOT CodeQL and
 * makes no network call: it catches the two well-known *shapes* cheaply at pre-push so
 * the coder fixes them before CI, not after a full repair → re-review → re-ship cycle.
 *
 * The two classes it decides over already-gathered facts:
 *
 *   1. workflow-permissions — a GitHub Actions workflow whose `GITHUB_TOKEN` scope is
 *      not pinned least-privilege. CodeQL's "Workflow does not contain permissions"
 *      (PR #2251). A workflow PASSES iff it declares an explicit `permissions:` block
 *      at the top level OR on every job; a workflow with no `permissions:` anywhere
 *      (or a job missing one when there is no top-level block) FAILS. The fix is the
 *      merged precedent: an explicit `permissions: { contents: read }`.
 *   2. redos — a regex literal whose structure admits catastrophic backtracking
 *      (CodeQL "Polynomial/exponential regular expression on uncontrolled data",
 *      PR #2258). Two textbook shapes are flagged, chosen to be unambiguous and
 *      low-false-positive (NOT the high-FP safe-regex star-height heuristic):
 *        a. nested quantifier — an unbounded-quantified group whose body is EXACTLY a
 *           single unbounded-quantified atom: `(a+)+`, `(a*)*`, `([a-z]+)*`, `(\d+){2,}`.
 *        b. quantified/overlapping alternation — an unbounded-quantified group whose
 *           body has a top-level `|` where a branch is itself a single unbounded-
 *           quantified atom (`(a+|b)*`) or two branches are identical (`(a|a)+`).
 *      The "single quantified atom" condition is load-bearing: it is what makes the
 *      catastrophe real (inner and outer quantifiers matching the SAME input
 *      ambiguously). A group that merely *ends* in a quantifier but has a mandatory
 *      disambiguating prefix — the standard kebab/slug `(-[a-z0-9]+)*`, each iteration
 *      forced to start with a literal `-` — is LINEAR, not catastrophic, and is
 *      deliberately NOT flagged (CodeQL does not flag it either); flagging it would
 *      false-fail the repo.
 *
 * IO-free and total: every decision is a deterministic transform over facts gathered at
 * the filesystem boundary (`gate.ts`); this module never touches disk. Fail-closed on
 * zero scope (ADR 0092): zero workflows AND zero source files discovered is a broken
 * scope assumption (a wrong root), not a vacuous pass.
 */
import {parse as parseYaml} from "yaml";

// ---------------------------------------------------------------------------
// Facts (gathered at the IO boundary, judged here)
// ---------------------------------------------------------------------------

/** The permissions facts parsed out of one workflow YAML file. */
export interface WorkflowFacts {
	/** Repo-relative POSIX path (e.g. `.github/workflows/leak-guard.yml`). */
	readonly path: string;
	/** Does the workflow declare a top-level `permissions:` key? */
	readonly hasTopLevelPermissions: boolean;
	/** Each job's id + whether it declares its own `permissions:` key. */
	readonly jobs: ReadonlyArray<{readonly name: string; readonly hasPermissions: boolean}>;
}

/** One regex literal (or `RegExp(...)` string arg) discovered in a source file. */
export interface RegexLiteral {
	readonly path: string;
	readonly line: number;
	/** The regex *source* (pattern body, without the delimiting slashes/flags). */
	readonly pattern: string;
}

/** Everything the gate gathered, ready to judge. */
export interface CodeqlLintFacts {
	readonly workflows: ReadonlyArray<WorkflowFacts>;
	readonly regexes: ReadonlyArray<RegexLiteral>;
}

/**
 * The grandfather baseline (mirrors design-token-guard's config model): the pre-existing
 * debt CodeQL default-setup already carries as unrelated alerts, so the gate is GREEN on
 * `main` while still failing on any NEW violation — the whole shift-left point is to
 * block net-new artifacts, not to boil the ocean on legacy workflows. Every entry is a
 * bounded, documented allow-list; adding one is a deliberate act (see the tool README).
 */
export interface CodeqlLintBaseline {
	/** Repo-relative workflow paths grandfathered as pre-existing permissions debt. */
	readonly grandfatheredWorkflows: ReadonlyArray<string>;
	/** Regex sources grandfathered as pre-existing (keyed by path + pattern, line-stable). */
	readonly grandfatheredRegexes: ReadonlyArray<{readonly path: string; readonly pattern: string}>;
}

export const EMPTY_BASELINE: CodeqlLintBaseline = {
	grandfatheredWorkflows: [],
	grandfatheredRegexes: [],
};

// ---------------------------------------------------------------------------
// Failures + verdict
// ---------------------------------------------------------------------------

/** A workflow whose GITHUB_TOKEN scope is not pinned least-privilege. */
export interface WorkflowPermissionsFailure {
	readonly path: string;
	/**
	 * The jobs missing a `permissions:` block (only when there is no top-level block).
	 * Empty when the workflow declares no `permissions:` anywhere and has no parseable
	 * jobs — i.e. nothing is pinned at all.
	 */
	readonly jobsMissing: ReadonlyArray<string>;
}

/** The two catastrophic-backtracking shapes. */
export type RedosKind = "nested-quantifier" | "quantified-alternation";

/** A regex literal whose structure admits catastrophic backtracking. */
export interface RedosFailure {
	readonly path: string;
	readonly line: number;
	readonly pattern: string;
	readonly kind: RedosKind;
}

export type CodeqlLintVerdict =
	| {readonly pass: true; readonly workflowsChecked: number; readonly regexesChecked: number}
	/** No workflows AND no source files in scope — fail closed, never a vacuous pass (ADR 0092). */
	| {readonly pass: false; readonly reason: "zero-scope"}
	| {
			readonly pass: false;
			readonly reason: "violations";
			readonly workflowPermissions: ReadonlyArray<WorkflowPermissionsFailure>;
			readonly redos: ReadonlyArray<RedosFailure>;
	  };

// ---------------------------------------------------------------------------
// Rule 1 — workflow permissions
// ---------------------------------------------------------------------------

/**
 * Parse a workflow YAML file into its permissions facts. A top-level `permissions:`
 * key pins the token for every job; otherwise each job must pin its own. A parse
 * failure (or a non-mapping document) yields "no top-level, no jobs" — which fails
 * the rule fail-closed (a workflow we cannot read is not a workflow we can clear).
 */
export const parseWorkflowFacts = (path: string, yamlText: string): WorkflowFacts => {
	let doc: unknown;
	try {
		doc = parseYaml(yamlText);
	} catch {
		return {path, hasTopLevelPermissions: false, jobs: []};
	}
	if (doc === null || typeof doc !== "object") {
		return {path, hasTopLevelPermissions: false, jobs: []};
	}
	const root = doc as Record<string, unknown>;
	const hasTopLevelPermissions = Object.hasOwn(root, "permissions");
	const jobsNode = root.jobs;
	const jobs: Array<{name: string; hasPermissions: boolean}> = [];
	if (jobsNode !== null && typeof jobsNode === "object") {
		for (const [name, body] of Object.entries(jobsNode as Record<string, unknown>)) {
			const hasPermissions =
				body !== null && typeof body === "object" && Object.hasOwn(body, "permissions");
			jobs.push({name, hasPermissions});
		}
	}
	return {path, hasTopLevelPermissions, jobs};
};

/**
 * A workflow clears the rule iff it declares a top-level `permissions:` block, or it
 * has at least one job and every job declares its own. Returns the failure (naming the
 * jobs missing a block) or `null` when the workflow is clear.
 */
export const judgeWorkflowPermissions = (w: WorkflowFacts): WorkflowPermissionsFailure | null => {
	if (w.hasTopLevelPermissions) return null;
	if (w.jobs.length > 0 && w.jobs.every((j) => j.hasPermissions)) return null;
	return {path: w.path, jobsMissing: w.jobs.filter((j) => !j.hasPermissions).map((j) => j.name)};
};

// ---------------------------------------------------------------------------
// Rule 2 — ReDoS (catastrophic backtracking)
// ---------------------------------------------------------------------------

/**
 * The outer quantifier that makes a group repeat unbounded: `*`, `+`, or an open-ended
 * `{n,}`. A bounded `{n,m}` / `{n}` does not blow up, so it is deliberately excluded.
 * `at` points at the quantifier char just after a group's `)`.
 */
const outerUnboundedQuantifierAt = (pattern: string, at: number): boolean => {
	const ch = pattern[at];
	if (ch === "*" || ch === "+") return true;
	if (ch === "{") {
		const close = pattern.indexOf("}", at);
		if (close === -1) return false;
		const inner = pattern.slice(at + 1, close);
		return /^\d*,\s*$/.test(inner); // e.g. "2," or "," — comma with no upper bound
	}
	return false;
};

/** Consume one atom from the start of `s`; return its length, or 0 if none. An atom is a
 * single char, an escape `\x`, a char class `[...]`, or a group `(...)`. */
const atomLength = (s: string): number => {
	if (s.length === 0) return 0;
	const c = s[0];
	if (c === "\\") return s.length >= 2 ? 2 : 0;
	if (c === "[") {
		let i = 1;
		if (s[i] === "^") i++;
		if (s[i] === "]") i++; // a leading `]` is a literal member
		while (i < s.length) {
			if (s[i] === "\\") i += 2;
			else if (s[i] === "]") return i + 1;
			else i++;
		}
		return 0; // unterminated class — not a clean atom
	}
	if (c === "(") {
		let depth = 0;
		let inClass = false;
		for (let i = 0; i < s.length; i++) {
			if (s[i] === "\\") {
				i++;
				continue;
			}
			if (inClass) {
				if (s[i] === "]") inClass = false;
				continue;
			}
			if (s[i] === "[") inClass = true;
			else if (s[i] === "(") depth++;
			else if (s[i] === ")" && --depth === 0) return i + 1;
		}
		return 0;
	}
	if (c === ")" || c === "|" || c === "*" || c === "+" || c === "?") return 0; // not an atom start
	return 1;
};

/**
 * Is this branch EXACTLY one atom followed by an unbounded quantifier (`+`, `*`, or open
 * `{n,}`), allowing a trailing lazy `?`? This — not "ends in a quantifier" — is the
 * catastrophic shape: `a+`, `[a-z]+`, `\d*`, `(ab)+` all qualify; `-[a-z]+` (two atoms,
 * the slug separator case) does NOT, because its mandatory `-` disambiguates iterations.
 */
const isSingleQuantifiedAtom = (branch: string): boolean => {
	const s = branch.replace(/\?$/, ""); // a trailing lazy `?` still backtracks
	const len = atomLength(s);
	if (len === 0 || len >= s.length) return false; // no atom, or nothing left for a quantifier
	const rest = s.slice(len);
	if (rest === "*" || rest === "+") return true;
	if (rest[0] === "{" && rest[rest.length - 1] === "}") {
		return /^\d*,\s*$/.test(rest.slice(1, rest.length - 1)); // `{n,}` open upper bound
	}
	return false;
};

/** Split a group body on its TOP-LEVEL `|` (depth-0, not inside nested `()`/`[]`). */
const splitTopLevelAlternation = (body: string): ReadonlyArray<string> => {
	const parts: Array<string> = [];
	let depth = 0;
	let inClass = false;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "\\") {
			i++; // skip the escaped char
			continue;
		}
		if (inClass) {
			if (ch === "]") inClass = false;
			continue;
		}
		if (ch === "[") inClass = true;
		else if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === "|" && depth === 0) {
			parts.push(body.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(body.slice(start));
	return parts;
};

/**
 * The core ReDoS shape detector: given a regex source, return the catastrophic-
 * backtracking kind it matches, or `null` when none. Walks the pattern once, tracking
 * group spans and char classes (parens inside `[...]` are literal), and — for each
 * unbounded-quantified group — inspects its body's top-level structure:
 *
 *   - a body that is EXACTLY a single unbounded-quantified atom → nested-quantifier;
 *   - a body with a top-level `|` where a branch is a single unbounded-quantified atom
 *     OR two branches are identical → quantified-alternation.
 *
 * A capturing/non-capturing/named group's leading `(?:` / `(?<name>` marker is stripped
 * before inspection; lookarounds are zero-width and never quantified, so they never
 * reach the quantifier test.
 */
export const detectRedos = (pattern: string): RedosKind | null => {
	const stack: Array<number> = []; // indices of unmatched `(`
	let inClass = false;
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			i++; // skip the escaped char
			continue;
		}
		if (inClass) {
			if (ch === "]") inClass = false;
			continue;
		}
		if (ch === "[") {
			inClass = true;
		} else if (ch === "(") {
			stack.push(i);
		} else if (ch === ")") {
			const open = stack.pop();
			if (open === undefined) continue; // unbalanced source — ignore, don't throw
			if (!outerUnboundedQuantifierAt(pattern, i + 1)) continue;
			let body = pattern.slice(open + 1, i);
			// strip a non-capturing / named / lookaround marker to get the raw body
			body = body.replace(/^\?(:|<[^>]*>|=|!|<=|<!)/, "");
			const branches = splitTopLevelAlternation(body);
			if (branches.length > 1) {
				if (branches.some(isSingleQuantifiedAtom)) return "quantified-alternation";
				const seen = new Set<string>();
				for (const b of branches) {
					const key = b.trim();
					if (key.length > 0 && seen.has(key)) return "quantified-alternation";
					seen.add(key);
				}
			} else if (isSingleQuantifiedAtom(body)) {
				return "nested-quantifier";
			}
		}
	}
	return null;
};

// ---------------------------------------------------------------------------
// Regex extraction from TS/JS source (comment/string aware)
// ---------------------------------------------------------------------------

/**
 * A `/` begins a regex literal (rather than division) when the previous significant
 * token is an operator / opener / keyword — the standard lexer heuristic. Kept as a set
 * of the last non-space char plus a small keyword set, which is deterministic and
 * sufficient for source-scanning (a mis-classified division rarely forms a quantified
 * group, and detectRedos would reject it anyway).
 */
const REGEX_PRECEDERS = new Set([
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
	"<",
	">",
	"~",
	"^",
]);
const REGEX_PRECEDING_KEYWORDS = new Set(["return", "typeof", "case", "in", "of", "do", "else"]);

/**
 * Extract regex literals + `RegExp(...)` / `new RegExp(...)` string-arg patterns from a
 * source file, comment- AND string-aware in a single pass. Returns `{line, pattern}` for
 * each. Being string-aware is load-bearing: a `new RegExp("(a+)+")` that appears INSIDE a
 * string literal (a test asserting on source text) must NOT be extracted — folding the
 * constructor detection into the scanner (rather than a separate post-scan regex) is what
 * gives that. Template-literal RegExp args are out of scope (rare; skipped) — see the tool
 * README for the documented scan surface.
 */
export const extractRegexes = (src: string): ReadonlyArray<{line: number; pattern: string}> => {
	const found: Array<{line: number; pattern: string}> = [];
	let line = 1;
	let prevSignificant = ""; // last non-space token char, for the regex/division call
	let word = ""; // the in-progress identifier run
	let lastWord = ""; // the most recently COMPLETED identifier (survives a whitespace boundary)
	let expectRegExpArg = false; // a `RegExp(` was just seen — its first string arg is a pattern
	const flushWord = () => {
		if (word) {
			lastWord = word;
			word = "";
		}
	};

	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (ch === undefined) break; // unreachable (i < length), but narrows `string | undefined`
		const next = src[i + 1];
		if (ch === "\n") {
			line++;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			i--; // let the loop see the newline
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
				if (src[i] === "\n") line++;
				i++;
			}
			i++; // skip the closing `/`
			continue;
		}
		// string / template literal — skipped, EXCEPT when it is the arg to `RegExp(`
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			const startLine = line;
			let raw = "";
			i++;
			while (i < src.length && src[i] !== quote) {
				if (src[i] === "\\") {
					raw += src[i] + (src[i + 1] ?? "");
					i += 2;
					continue;
				}
				if (src[i] === "\n") line++;
				raw += src[i];
				i++;
			}
			if (expectRegExpArg && quote !== "`") {
				// recover the regex source from the string literal (undo its `\` escapes)
				found.push({line: startLine, pattern: raw.replace(/\\(.)/g, "$1")});
			}
			prevSignificant = quote;
			word = "";
			lastWord = "";
			expectRegExpArg = false;
			continue;
		}
		// regex literal
		if (ch === "/") {
			const wordBefore = word || lastWord;
			const startsRegex =
				prevSignificant === "" ||
				REGEX_PRECEDERS.has(prevSignificant) ||
				REGEX_PRECEDING_KEYWORDS.has(wordBefore);
			if (startsRegex) {
				let j = i + 1;
				let cls = false;
				let ok = false;
				const startLine = line;
				while (j < src.length) {
					const c = src[j];
					if (c === "\\") {
						j += 2;
						continue;
					}
					if (c === "\n") break; // unterminated on this line — not a regex
					if (cls) {
						if (c === "]") cls = false;
					} else if (c === "[") {
						cls = true;
					} else if (c === "/") {
						ok = true;
						break;
					}
					j++;
				}
				if (ok) {
					found.push({line: startLine, pattern: src.slice(i + 1, j)});
					i = j; // resume after the closing slash
					prevSignificant = "/";
					word = "";
					lastWord = "";
					expectRegExpArg = false;
					continue;
				}
			}
		}
		if (/\s/.test(ch)) {
			flushWord(); // whitespace ends an identifier but preserves prevSignificant
			continue;
		}
		if (/[A-Za-z_$0-9]/.test(ch)) {
			word += ch;
			expectRegExpArg = false;
		} else if (ch === "(") {
			flushWord();
			expectRegExpArg = lastWord === "RegExp"; // `RegExp(` / `new RegExp(`
		} else {
			flushWord();
			expectRegExpArg = false; // only an IMMEDIATE string arg counts
		}
		prevSignificant = ch;
	}
	return found;
};

// ---------------------------------------------------------------------------
// Verdict + report
// ---------------------------------------------------------------------------

/**
 * Decide the verdict over the gathered facts: fail-closed on zero scope, then gather
 * both violation classes and fail if either is non-empty. The two checks are independent
 * so one run surfaces every finding.
 */
export const judge = (
	facts: CodeqlLintFacts,
	baseline: CodeqlLintBaseline = EMPTY_BASELINE,
): CodeqlLintVerdict => {
	if (facts.workflows.length === 0 && facts.regexes.length === 0) {
		return {pass: false, reason: "zero-scope"};
	}
	const grandfatheredWorkflows = new Set(baseline.grandfatheredWorkflows);
	const grandfatheredRegexes = new Set(
		baseline.grandfatheredRegexes.map((g) => `${g.path} ${g.pattern}`),
	);
	const workflowPermissions = facts.workflows
		.map(judgeWorkflowPermissions)
		.filter((f): f is WorkflowPermissionsFailure => f !== null)
		.filter((f) => !grandfatheredWorkflows.has(f.path));
	const redos: Array<RedosFailure> = [];
	for (const r of facts.regexes) {
		if (grandfatheredRegexes.has(`${r.path} ${r.pattern}`)) continue;
		const kind = detectRedos(r.pattern);
		if (kind !== null) redos.push({path: r.path, line: r.line, pattern: r.pattern, kind});
	}
	if (workflowPermissions.length === 0 && redos.length === 0) {
		return {
			pass: true,
			workflowsChecked: facts.workflows.length,
			regexesChecked: facts.regexes.length,
		};
	}
	return {pass: false, reason: "violations", workflowPermissions, redos};
};

/** Render a human-readable report for either verdict polarity. */
export const renderReport = (verdict: CodeqlLintVerdict): string => {
	if (verdict.pass) {
		return `codeql-lint: PASS — ${verdict.workflowsChecked} workflow(s) pin least-privilege permissions, ${verdict.regexesChecked} regex(es) clear of catastrophic backtracking.`;
	}
	if (verdict.reason === "zero-scope") {
		return "codeql-lint: FAIL (fail-closed) — zero workflows AND zero source files in scope; the scan root is wrong (ADR 0092).";
	}
	const lines: Array<string> = [
		"codeql-lint: FAIL — author-time CodeQL shapes found (fix before push):",
	];
	if (verdict.workflowPermissions.length > 0) {
		lines.push(
			"",
			"  workflow-permissions (add an explicit least-privilege `permissions:` block, e.g. `permissions: { contents: read }`):",
		);
		for (const f of verdict.workflowPermissions) {
			const where =
				f.jobsMissing.length > 0
					? ` — no top-level block and jobs missing one: ${f.jobsMissing.join(", ")}`
					: " — no `permissions:` declared anywhere";
			lines.push(`    ${f.path}${where}`);
		}
	}
	if (verdict.redos.length > 0) {
		lines.push(
			"",
			"  redos (catastrophic backtracking — restructure to linear/bounded, clamp input length):",
		);
		for (const f of verdict.redos) {
			lines.push(`    ${f.path}:${f.line} [${f.kind}] /${f.pattern}/`);
		}
	}
	return lines.join("\n");
};
