/**
 * The JSON boundary for `gh api` responses.
 *
 * **No `effect` import here on purpose.** Parsing an untrusted string needs a native `try/catch`,
 * and the repo bans that inside Effect control flow (#2736) — so this is the boundary half, and the
 * Effect seams in `issues.ts` wrap it. A parse that fails resolves to `null`, which every caller
 * turns into a typed refusal rather than into an empty result.
 */

/** The parsed value, or `null` when the bytes were not JSON at all. */
export const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
