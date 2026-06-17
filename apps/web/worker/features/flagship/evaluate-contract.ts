/**
 * The wire contract for `POST /api/flags/evaluate` (epic #488, #510) — the SPA's
 * flag-delivery seam. The client names the flags it needs as `{key, default}`
 * pairs; the Worker returns the server-evaluated boolean for each. Both halves of
 * the parse/project edge live here as pure functions so they're unit-testable
 * without a worker (server side) or a DOM (client side), mirroring the
 * `toProfileStatsState` idiom (`src/pages/useProfileStats.ts`).
 *
 * The default rides the request and is the safe path on every failure: a
 * malformed request collapses to zero keys, and a key missing from the response
 * resolves to its default ({@link resolveFlag}) — so a bad request or a flaky
 * server leaves the client at its defaults, never crashes it.
 */

/** One requested flag: the key to evaluate and its safe-default fallback. */
export interface FlagRequest {
	readonly key: string;
	readonly default: boolean;
}

/** The evaluate request body the client sends. */
export interface FlagEvaluateRequest {
	readonly keys: ReadonlyArray<FlagRequest>;
}

/** The evaluate response body: each requested key mapped to its server value. */
export interface FlagEvaluateResult {
	readonly flags: Record<string, boolean>;
}

/**
 * Parse an untrusted request body into the requested flag keys, dropping any
 * malformed entry. Anything that isn't a well-formed `{keys: [{key, default}]}`
 * yields `[]` — the server then returns `{flags:{}}` and the client stays at its
 * defaults, so a bad request degrades safe rather than 500ing.
 */
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
 * Resolve one flag's value from a server response, falling back to `defaultValue`
 * when the response didn't return the key or returned a non-boolean. The input is
 * `unknown` on purpose — it is parsed from untrusted JSON (`res.json()`), so the
 * structural guard here, not a cast at the call site, is what enforces the
 * client's safe-default guarantee: until the server says otherwise — and only
 * with a genuine boolean — the default holds.
 */
export function resolveFlag(result: unknown, key: string, defaultValue: boolean): boolean {
	if (typeof result !== "object" || result === null) return defaultValue;
	const flags = (result as {flags?: unknown}).flags;
	if (typeof flags !== "object" || flags === null) return defaultValue;
	const value = (flags as Record<string, unknown>)[key];
	return typeof value === "boolean" ? value : defaultValue;
}
