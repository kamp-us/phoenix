export type JsonParseResult =
	| {readonly _tag: "Parsed"; readonly value: unknown}
	| {readonly _tag: "Failed"; readonly cause: unknown};

export const parsePackageJson = (text: string): JsonParseResult => {
	try {
		return {_tag: "Parsed", value: JSON.parse(text)};
	} catch (cause) {
		return {_tag: "Failed", cause};
	}
};
