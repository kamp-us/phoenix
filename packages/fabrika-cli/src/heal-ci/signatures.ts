/**
 * The failure-signature taxonomy: a closed, **ordered** table of eleven rows, and the default-deny
 * lookup over it.
 *
 * The order is part of the contract, not an implementation detail — the classes genuinely overlap
 * (an OOM-killed suite prints assertion output before it dies, and a preview target answering `502`
 * matches both a warmup row and a generic network row), so the first matching row wins and specific
 * rows precede general ones. Transient rows precede logic rows so an infrastructure death is not
 * read as the assertion failure it printed on its way down.
 *
 * The one `derived` row is last. It is the only row whose match says the log holds no failure of
 * its own, so every row that names a real failure must be able to beat it: a roll-up that also
 * printed a defect is that defect. A row added later goes above it.
 *
 * The table grows by adding a row, never by branching inside a verb: it is data, under unit test
 * against fixture logs.
 *
 * A secret scanner's committed-secret finding is deliberately not a row. It stays `unclassified`
 * so it reaches a person who removes the secret and rotates the credential; a `logic` row would
 * hand a repair lane a pull request carrying a live secret.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/7288#issuecomment-5519663185
 * @ruling https://github.com/kamp-us/phoenix/issues/7206#issuecomment-5460774567
 */

/**
 * `derived` is a log that only restates another job's verdict. It is not `unclassified`, which
 * stays "nothing matched", and it is not a stall class: why one pull request is stuck is
 * `stall.ts`'s vocabulary, and no token crosses between the two unions.
 */
export type SignatureClass = "transient" | "logic" | "derived";

export interface Signature {
	readonly id: string;
	readonly class: SignatureClass;
	/** Applied per line, case-insensitively. */
	readonly pattern: RegExp;
	readonly rationale: string;
}

/** The eleven rows, in precedence order. Index 0 is tested first. */
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
		rationale: "this PR's own preview target was not up yet",
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
	{
		id: "roll-up-verdict",
		class: "derived",
		pattern: /\bresult=\S+ (?:→|->) FAIL\b|\bci-required FAILED\b/i,
		rationale:
			"a roll-up restating another job's verdict, with no failure of its own — route the job its FAIL line names",
	},
];

/** The ids a rerun may be justified by: a retry changes nothing a `logic` or `derived` row found. */
export const RERUNNABLE_SIGNATURE_IDS: ReadonlyArray<string> = SIGNATURES.filter(
	(row) => row.class === "transient",
).map((row) => row.id);

export type RerunLicence =
	| {readonly _tag: "Licensed"; readonly signature: Signature}
	| {readonly _tag: "NotTransient"; readonly signature: Signature}
	| {readonly _tag: "UnknownId"};

/** Whether a signature id licenses the one rerun. Only a `transient` row does. */
export const rerunLicence = (id: string): RerunLicence => {
	const signature = SIGNATURES.find((row) => row.id === id);
	if (signature === undefined) return {_tag: "UnknownId"};
	return signature.class === "transient"
		? {_tag: "Licensed", signature}
		: {_tag: "NotTransient", signature};
};

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
