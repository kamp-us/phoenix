/**
 * The wire contract for `POST /api/flags/evaluate`. Both halves of the parse/project
 * edge live here as pure functions so they are unit-testable without a worker or a DOM.
 *
 * The default rides the request and is the safe path on every failure: a malformed
 * request collapses to zero keys, and a missing key resolves to its default — so a bad
 * request or a flaky server leaves the client at its defaults, never crashes it.
 */

export interface FlagRequest {
	readonly key: string;
	readonly default: boolean;
}

export interface FlagEvaluateRequest {
	readonly keys: ReadonlyArray<FlagRequest>;
}

export interface FlagEvaluateResult {
	readonly flags: Record<string, boolean>;
}

/** Anything not well-formed yields `[]`, so a bad request degrades safe rather than 500ing. */
export function parseFlagEvaluateRequest(body: unknown): ReadonlyArray<FlagRequest> {
	if (typeof body !== "object" || body === null) return [];
	const keys = (body as {keys?: unknown}).keys;
	if (!Array.isArray(keys)) return [];
	return keys.flatMap((entry) => {
		if (typeof entry !== "object" || entry === null) return [];
		const {key, default: def} = entry as {key?: unknown; default?: unknown};
		if (typeof key !== "string" || typeof def !== "boolean") return [];
		return [{key, default: def}];
	});
}

/**
 * The input is `unknown` on purpose — it comes from untrusted JSON, so the structural
 * guard here, not a cast at the call site, is what enforces the safe-default guarantee.
 */
export function resolveFlag(result: unknown, key: string, defaultValue: boolean): boolean {
	if (typeof result !== "object" || result === null) return defaultValue;
	const flags = (result as {flags?: unknown}).flags;
	if (typeof flags !== "object" || flags === null) return defaultValue;
	const value = (flags as Record<string, unknown>)[key];
	return typeof value === "boolean" ? value : defaultValue;
}
