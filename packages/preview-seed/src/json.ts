/**
 * The JSON boundary: the one native `try/catch` around `JSON.parse` in this package. No `effect`
 * import here on purpose, because the lint bans a raw `try/catch` in a file that has one.
 *
 * The engine's own message is dropped rather than returned. It quotes a slice of the text it failed
 * on, and the one caller here parses a value made of logins.
 */
export type JsonParse =
	| {readonly _tag: "Parsed"; readonly value: unknown}
	| {readonly _tag: "Failed"};

export const parseJson = (text: string): JsonParse => {
	try {
		return {_tag: "Parsed", value: JSON.parse(text) as unknown};
	} catch {
		return {_tag: "Failed"};
	}
};
