/**
 * The failure-signature taxonomy: a closed, **ordered** table of ten rows, and the default-deny
 * lookup over it.
 *
 * The order is part of the contract, not an implementation detail — the classes genuinely overlap
 * (an OOM-killed suite prints assertion output before it dies, and a preview target answering `502`
 * matches both a warmup row and a generic network row), so the first matching row wins and specific
 * rows precede general ones. Transient rows precede logic rows so an infrastructure death is not
 * read as the assertion failure it printed on its way down.
 *
 * The table grows by adding a row, never by branching inside a verb: it is data, under unit test
 * against fixture logs.
 */

export type SignatureClass = "transient" | "logic";

export interface Signature {
	readonly id: string;
	readonly class: SignatureClass;
	/** Applied per line, case-insensitively. */
	readonly pattern: RegExp;
	readonly rationale: string;
}

/** The ten rows, in precedence order. Index 0 is tested first. */
export const SIGNATURES: ReadonlyArray<Signature> = [
	{
		id: "runner-oom",
		class: "transient",
		pattern: /\b(sigkill|out of memory|oom-killed|exit code 137)\b/i,
		rationale: "the runner was killed, so whatever it printed on the way down proves nothing",
	},
	{
		id: "runner-cancelled-infra",
		class: "transient",
		pattern:
			/\b(the runner has received a shutdown signal|the operation was canceled by the (?:runner|server))\b/i,
		rationale: "the platform withdrew the runner; no code ran to completion",
	},
	{
		id: "rate-limited",
		class: "transient",
		pattern: /\b(429|rate limit exceeded|secondary rate limit|api rate limit|quota exceeded)\b/i,
		rationale: "a quota, not a defect — the same tree passes once the window resets",
	},
	{
		id: "preview-warmup",
		class: "transient",
		pattern:
			/(preview|deployment|deployed target).{0,80}?\b(not reachable|did not become reachable|connection refused|502|503|504)\b/i,
		rationale: "this PR's own preview target was not up yet (#5348)",
	},
	{
		id: "readiness-stall",
		class: "transient",
		pattern:
			/\b(readiness|health ?check|waiting for .{0,40}to be ready)\b.{0,60}\b(timed out|timeout|exceeded)\b/i,
		rationale: "a dependency never became ready inside the wait, which the tree does not decide",
	},
	{
		id: "network-transient",
		class: "transient",
		pattern:
			/\b(etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|tls handshake timeout)\b/i,
		rationale: "a transport fault between the runner and something it needed",
	},
	{
		id: "assertion-failure",
		class: "logic",
		pattern: /\b(assertionerror|expected .{0,40} to (?:be|equal|contain)|toEqual|toBe)\b/i,
		rationale: "a test asserted something the tree does not do — deterministic, so repair it",
	},
	{
		id: "typecheck-failure",
		class: "logic",
		pattern: /\berror TS\d{4,5}\b/i,
		rationale: "the checker rejected the tree; a rerun re-derives the same error",
	},
	{
		id: "lint-failure",
		class: "logic",
		pattern: /\b(eslint|biome)\b.{0,60}\berror\b|^\s*error\s+.{0,80}\s+@?[\w/-]+\/[\w-]+$/i,
		rationale: "a lint rule rejected the tree; a rerun re-derives the same error",
	},
	{
		id: "build-failure",
		class: "logic",
		pattern:
			/\b(cannot find module|module not found|failed to resolve import|syntaxerror|unexpected token)\b/i,
		rationale: "the tree does not build, which no retry changes",
	},
];

export const SIGNATURE_IDS: ReadonlyArray<string> = SIGNATURES.map((row) => row.id);

export const isSignatureId = (value: string): boolean => SIGNATURE_IDS.includes(value);

/** `unclassified` is a **third** token: recognising nothing is not the same as recognising a bug. */
export type Classification =
	| {
			readonly _tag: "Matched";
			readonly signature: Signature;
			/** 1-based within the block the text came from. */
			readonly line: number;
	  }
	| {readonly _tag: "Unclassified"; readonly lines: number};

/**
 * The first row whose pattern matches any line, scanned row-major so precedence is the table's.
 *
 * Row-major and not line-major: a lower row matching an earlier line must not beat a higher row
 * matching a later one, which is the whole point of ordering an overlapping table. There is no path
 * from unmatched input to `transient`.
 */
export const classifyLog = (text: string): Classification => {
	const lines = text.split("\n");
	for (const signature of SIGNATURES) {
		for (const [index, line] of lines.entries()) {
			if (signature.pattern.test(line)) return {_tag: "Matched", signature, line: index + 1};
		}
	}
	return {_tag: "Unclassified", lines: lines.length};
};
