/**
 * The JSON boundary — the one native `try/catch` around `JSON.parse` in this package.
 *
 * **No `effect` import here on purpose.** Parsing an untrusted string needs a native `try/catch`,
 * and the repo bans that inside Effect control flow (#2736) — so this is the boundary half, and the
 * Effect seams in `issues.ts` wrap it. A parse that fails never resolves to a value: it is either
 * `null` or a tagged reason, which every caller turns into a typed refusal rather than into an
 * empty result.
 */

/** A parse that landed, or the engine's own reason when the bytes were not JSON at all. */
export type JsonParse =
	| {readonly _tag: "Parsed"; readonly value: unknown}
	| {readonly _tag: "Failed"; readonly reason: string};

/** The parsed value, or why the bytes were not JSON — for a caller that reports the reason. */
export const parseJsonOrReason = (text: string): JsonParse => {
	try {
		return {_tag: "Parsed", value: JSON.parse(text) as unknown};
	} catch (err) {
		return {_tag: "Failed", reason: (err as Error).message};
	}
};

/** The parsed value, or `null` when the bytes were not JSON at all. */
export const parseJson = (text: string): unknown => {
	const parsed = parseJsonOrReason(text);
	return parsed._tag === "Parsed" ? parsed.value : null;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
