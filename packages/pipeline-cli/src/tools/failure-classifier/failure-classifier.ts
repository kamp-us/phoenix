/**
 * `failure-classifier` core — the pure, IO-free decision that classifies a crashed
 * dynamic Workflow's failure signal as `transient` or `logic`, for the orchestrator-layer
 * auto-resume of crashed overnight drains (epic #1751, child #1758).
 *
 * The taxonomy has exactly two classes, which need OPPOSITE treatment (epic #1751):
 *   - TRANSIENT — dead subagent / null result / process exit / API-or-session-limit
 *     death. Safe to auto-resume: the failed stage is likely to succeed on re-run and
 *     completed stages replay from the journal cache on `resumeFromRunId`.
 *   - LOGIC / SCRIPT — null deref, wrong-arg-type, schema mismatch, or any error that
 *     re-crashes identically on the same inputs. NEVER auto-resume — surface immediately;
 *     blind resume is a token-burning infinite crash loop.
 *
 * The contract is **default-deny toward LOGIC**: a crash reason that matches no known
 * TRANSIENT signature classifies as `logic` (surface), never `transient` (blind resume).
 * This mirrors `drive-issue.js`'s `selectReviewTier` default-deny (ADR 0120 §3) — a
 * misclassification can only ever over-surface (a human looks at a recoverable death),
 * never over-resume (a logic bug loops burning tokens). Over-surfacing is cheap; a burn
 * loop is not.
 *
 * This file holds only the classification over plain values, with no disk and no network
 * (the core-in-its-own-file idiom; the `epic-ledger`/`crabbox-manifest`/`trivial-diff`
 * shape, CLAUDE.md "Node over Python"). `command.ts` is the thin CLI bin that reads the
 * crash signal from stdin/flags and calls `classify` here. Wiring this verdict to an
 * ACTUAL resume (and the K-cap) is sibling #1759's job — this child produces only the
 * verdict and its unit tests.
 */

/** The two terminal classes — no third "unknown" a caller could read as safe-to-resume. */
export type FailureClass = "transient" | "logic";

/**
 * The crash signal the classifier decides over: the raw reason/error text plus optional
 * structured hints the orchestrator can lift off a `status: failed` event and its
 * `<recovery>` block. All fields are best-effort — the classifier never requires a hint
 * to be present, and an all-empty signal is a well-formed default-deny (→ `logic`).
 */
export interface CrashSignal {
	/** The crash reason / error message text — the primary discriminator. */
	readonly reason?: string | undefined;
	/**
	 * A structured error kind if the orchestrator resolved one (e.g. `"TypeError"`,
	 * `"process_exit"`). Matched with the same TRANSIENT/LOGIC signatures as `reason`.
	 */
	readonly errorKind?: string | undefined;
	/** The failed stage name (diagnostic only — carried into the rationale, never decisive). */
	readonly stage?: string | undefined;
}

/** The verdict: the class + a human-readable rationale naming the deciding signature. */
export interface Verdict {
	readonly class: FailureClass;
	readonly rationale: string;
}

/**
 * TRANSIENT signatures — the crash classes that re-run cleanly (epic #1751 story 1). A
 * signal is TRANSIENT only on a positive match here; everything else defaults to LOGIC.
 * Grounded in the epic's three observed overnight crashes (null-verdict, whole-process
 * death on a model switch, plus API/session-limit subagent deaths) — kept deliberately
 * narrow so the default-deny bias holds: a new/ambiguous reason falls through to LOGIC.
 */
const TRANSIENT_SIGNATURES: ReadonlyArray<{readonly re: RegExp; readonly label: string}> = [
	// A subagent returned no result — the API/session-limit death that yields a null verdict.
	{re: /\bnull\s+(sub-?agent\s+)?result\b/i, label: "null subagent result"},
	{re: /\bsub-?agent\s+(returned\s+)?null\b/i, label: "null subagent result"},
	// API / rate / session / usage / token limit deaths — the subagent hit a quota and died.
	{
		re: /\b(api|rate|session|usage|token|quota)[- ]?limit\b/i,
		label: "API/session/rate limit death",
	},
	{re: /\b(429|rate[- ]?limited|overloaded|capacity)\b/i, label: "API overload/rate-limit death"},
	// Parent / subagent process exit or death — incl. the whole-process death on a model
	// switch. The separator class is `[\s_-]+` so a structured `process_exit` errorKind
	// matches alongside the free-text "process exited"; `_` is a word char, so a trailing
	// `\b` after `process` would never fire against `process_exit` (no boundary at `_`).
	{re: /process[\s_-]+exit(ed)?/i, label: "process exit"},
	{re: /process[\s_-]+(death|died|killed)/i, label: "process death"},
	{re: /\bmodel\s+switch\b/i, label: "process death on model switch"},
	{re: /\b(sigkill|sigterm|exit\s+code\s+(137|143))\b/i, label: "process killed (signal)"},
	{re: /\bsubagent\s+(died|crashed|timed?\s*out)\b/i, label: "subagent death/timeout"},
];

/**
 * LOGIC signatures — same-inputs-re-crash classes (epic #1751 story 4). These are matched
 * ONLY to enrich the rationale; the default is already LOGIC, so a signal that matches no
 * TRANSIENT signature is LOGIC whether or not it matches one of these. Listed so a
 * recognized logic crash names its kind ("null deref", "schema mismatch") instead of the
 * generic default-deny rationale.
 */
const LOGIC_SIGNATURES: ReadonlyArray<{readonly re: RegExp; readonly label: string}> = [
	{
		re: /\b(cannot\s+read\s+(properties|property)|null\s+deref|undefined\s+is\s+not|null\s+pointer)\b/i,
		label: "null/undefined dereference",
	},
	{re: /\btypeerror\b/i, label: "type error"},
	{
		re: /\b(wrong[- ]?arg|argument\s+of\s+type|not\s+assignable|expected\s+\w+\s*,?\s*(but\s+)?(got|received))\b/i,
		label: "wrong-arg-type",
	},
	{
		re: /\b(schema\s+(mismatch|validation)|failed\s+to\s+parse|parse\s+error|invalid\s+schema)\b/i,
		label: "schema mismatch",
	},
	{
		re: /\b(referenceerror|is\s+not\s+defined|is\s+not\s+a\s+function)\b/i,
		label: "reference/call error",
	},
];

const firstMatch = (
	text: string,
	sigs: ReadonlyArray<{readonly re: RegExp; readonly label: string}>,
): string | null => {
	for (const {re, label} of sigs) {
		if (re.test(text)) return label;
	}
	return null;
};

/**
 * Classify a crash signal as `transient` or `logic`. Default-deny by construction: the
 * verdict is `transient` ONLY on a positive match against a TRANSIENT signature; every
 * other input — an empty signal, an unrecognized reason, a recognized LOGIC crash — is
 * `logic`. There is no path from an ambiguous input to `transient`.
 */
export const classify = (signal: CrashSignal): Verdict => {
	// The two free-text fields the signatures scan. `stage` is diagnostic only.
	const haystack = [signal.reason, signal.errorKind]
		.filter((s): s is string => typeof s === "string")
		.join(" \n ");
	const stageNote = signal.stage ? ` (failed stage: ${signal.stage})` : "";

	if (haystack.trim() === "") {
		return {
			class: "logic",
			rationale: `empty crash signal — no reason/errorKind to classify; default-deny to LOGIC (surface, never blind-resume)${stageNote}.`,
		};
	}

	const transientHit = firstMatch(haystack, TRANSIENT_SIGNATURES);
	if (transientHit !== null) {
		return {
			class: "transient",
			rationale: `TRANSIENT signature matched (${transientHit}) — safe to auto-resume; completed stages replay from the journal cache${stageNote}.`,
		};
	}

	const logicHit = firstMatch(haystack, LOGIC_SIGNATURES);
	if (logicHit !== null) {
		return {
			class: "logic",
			rationale: `LOGIC signature matched (${logicHit}) — re-crashes identically on the same inputs; surface, never resume${stageNote}.`,
		};
	}

	return {
		class: "logic",
		rationale: `unrecognized crash reason — no TRANSIENT signature matched; default-deny to LOGIC (surface, never blind-resume into a token-burning loop)${stageNote}.`,
	};
};
