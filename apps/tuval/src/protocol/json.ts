/**
 * The JSON boundary for the protocol.
 *
 * **No `effect` import here on purpose.** Parsing an untrusted string needs a native `try/catch`,
 * which the repo bans inside Effect control flow (#2736), so the boundary lives in its own module
 * and the Effect seams in `codec.ts` wrap it. A parse that fails never resolves to a value: it is a
 * tagged reason the caller turns into a typed refusal.
 */

export type JsonParse =
	| {readonly _tag: "Parsed"; readonly value: unknown}
	| {readonly _tag: "Failed"; readonly reason: string};

export const parseJson = (text: string): JsonParse => {
	try {
		return {_tag: "Parsed", value: JSON.parse(text) as unknown};
	} catch (cause) {
		return {_tag: "Failed", reason: (cause as Error).message};
	}
};

export type JsonStringify =
	| {readonly _tag: "Stringified"; readonly text: string}
	| {readonly _tag: "Failed"; readonly reason: string};

/**
 * Symmetric with `parseJson`, and for the same reason: three message fields are `Schema.Unknown`, so
 * encode is identity there and a BigInt or a cycle reaches `JSON.stringify` unchanged. A bare call
 * would throw past the codec's error channel.
 */
export const stringifyJson = (value: unknown): JsonStringify => {
	try {
		const text = JSON.stringify(value);
		return text === undefined
			? {_tag: "Failed", reason: "the value has no JSON form"}
			: {_tag: "Stringified", text};
	} catch (cause) {
		return {_tag: "Failed", reason: (cause as Error).message};
	}
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
