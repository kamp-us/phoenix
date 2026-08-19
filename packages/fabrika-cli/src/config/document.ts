/**
 * The bytes of `.fabrika.jsonc`, opened once and parsed once per load.
 *
 * The three arms a key module never gets to see are settled here: a file nobody wrote, a file that
 * read but is not a JSON object, and a read that failed. Only the last is UNKNOWN — an absent file
 * is a repo that declared nothing and resolves to every key's shipped default, while a read fault
 * proves nothing about what the repo declared and every caller refuses on it.
 */

import {isRecord, parseJson} from "../io/json.ts";

/** The file, at the repository root. Read at a base ref, never from the working tree (#981). */
export const CONFIG_PATH = ".fabrika.jsonc";

/**
 * Strip line and block comments, leaving string literals untouched, so the bytes parse as JSON.
 *
 * Hand-written rather than taken from a dependency because the whole surface is two comment forms
 * and one escape rule, and the string-awareness is the part that matters: a naive strip cuts a URL
 * in half at its `//` and turns a readable config into "the document is not JSON".
 */
export const stripJsonComments = (text: string): string => {
	let out = "";
	let inString = false;
	let escaped = false;
	let index = 0;
	while (index < text.length) {
		const char = text[index] ?? "";
		if (inString) {
			out += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			index += 1;
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			index += 1;
			continue;
		}
		if (char === "/" && text[index + 1] === "/") {
			while (index < text.length && text[index] !== "\n") index += 1;
			continue;
		}
		if (char === "/" && text[index + 1] === "*") {
			index += 2;
			while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
			index += 2;
			continue;
		}
		out += char;
		index += 1;
	}
	return out;
};

/**
 * The file as its caller found it. Whoever opens the bytes — an `fs` read of the working root, a
 * `git show` at a base ref — reports which of the three it got, and the loader does the rest.
 */
export type ConfigSource =
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Text"; readonly text: string}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/** What one load found: the parsed record, or the reason there is none. */
export type DocumentState =
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Record"; readonly record: Record<string, unknown>}
	| {readonly _tag: "NotAnObject"; readonly reason: string}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/** Comment-strip and parse, once. Every key module is handed the record this produces. */
export const readDocument = (source: ConfigSource): DocumentState => {
	if (source._tag !== "Text") return source;
	const parsed = parseJson(stripJsonComments(source.text));
	return isRecord(parsed)
		? {_tag: "Record", record: parsed}
		: {_tag: "NotAnObject", reason: `${CONFIG_PATH} is not a JSON object with comments`};
};
