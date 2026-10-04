/**
 * One value set inside a JSON-with-comments document, with every other byte left where it was.
 *
 * `.fabrika.jsonc` is a file a person writes and annotates, so the parse-merge-reserialize a plain
 * JSON target takes would delete the comments that say why each value is what it is. The edit here
 * is textual instead: it finds the span the value occupies, or the object the member belongs in, and
 * splices only that.
 *
 * The scanner reads the same two comment forms and the same string escape `stripJsonComments` does,
 * and nothing wider: no trailing commas, no unquoted keys. A document it cannot walk is refused
 * rather than guessed at, and the caller re-parses what comes back before writing it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10362#issuecomment-5974640994
 */

import {parseJson} from "../io/json.ts";

export type JsoncEdit =
	| {readonly _tag: "Edited"; readonly text: string}
	| {readonly _tag: "Refused"; readonly reason: string};

interface Member {
	readonly key: string;
	readonly keyStart: number;
	readonly start: number;
	readonly end: number;
}

interface ObjectSpan {
	readonly open: number;
	readonly close: number;
	readonly members: ReadonlyArray<Member>;
}

const DEFAULT_INDENT = "\t";

/** The index of the first character at or after `from` that is neither whitespace nor comment. */
const skipTrivia = (text: string, from: number): number => {
	let index = from;
	while (index < text.length) {
		const char = text[index] ?? "";
		if (/\s/.test(char)) {
			index += 1;
		} else if (char === "/" && text[index + 1] === "/") {
			while (index < text.length && text[index] !== "\n") index += 1;
		} else if (char === "/" && text[index + 1] === "*") {
			const closed = text.indexOf("*/", index + 2);
			if (closed === -1) return text.length;
			index = closed + 2;
		} else {
			return index;
		}
	}
	return index;
};

/** The index just past the string opening at `from`, or `null` when it never closes. */
const stringEnd = (text: string, from: number): number | null => {
	let index = from + 1;
	while (index < text.length) {
		const char = text[index];
		if (char === "\\") index += 2;
		else if (char === '"') return index + 1;
		else index += 1;
	}
	return null;
};

/** The index just past the value starting at `from`, or `null` when it has no end. */
const valueEnd = (text: string, from: number): number | null => {
	const first = text[from];
	if (first === '"') return stringEnd(text, from);
	if (first !== "{" && first !== "[") {
		let index = from;
		while (index < text.length && !/[\s,}\]/]/.test(text[index] ?? "")) index += 1;
		return index === from ? null : index;
	}
	let depth = 0;
	let index = from;
	while (index < text.length) {
		const char = text[index] ?? "";
		if (char === '"') {
			const end = stringEnd(text, index);
			if (end === null) return null;
			index = end;
			continue;
		}
		if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
			index = skipTrivia(text, index);
			continue;
		}
		if (char === "{" || char === "[") depth += 1;
		if (char === "}" || char === "]") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
		index += 1;
	}
	return null;
};

/** The members of the object opening at `open`, each with its value's span. */
const objectAt = (text: string, open: number): ObjectSpan | null => {
	if (text[open] !== "{") return null;
	const members: Member[] = [];
	let index = skipTrivia(text, open + 1);
	while (index < text.length) {
		if (text[index] === "}") return {open, close: index, members};
		if (text[index] !== '"') return null;
		const keyEnd = stringEnd(text, index);
		if (keyEnd === null) return null;
		const key = parseJson(text.slice(index, keyEnd));
		const colon = skipTrivia(text, keyEnd);
		if (typeof key !== "string" || text[colon] !== ":") return null;
		const start = skipTrivia(text, colon + 1);
		const end = valueEnd(text, start);
		if (end === null) return null;
		members.push({key, keyStart: index, start, end});
		index = skipTrivia(text, end);
		if (text[index] === ",") index = skipTrivia(text, index + 1);
	}
	return null;
};

/** The whitespace the line holding `index` begins with. */
const lineIndent = (text: string, index: number): string => {
	const lineStart = text.lastIndexOf("\n", index - 1) + 1;
	return /^[ \t]*/.exec(text.slice(lineStart, index))?.[0] ?? "";
};

/** `value` as JSON, its continuation lines indented to sit under a member at `indent`. */
const render = (value: unknown, indent: string, unit: string): string =>
	JSON.stringify(value, null, unit).replace(/\n/g, `\n${indent}`);

/** One indent step, read off the root's first member so the new lines match the file's own. */
const indentUnit = (text: string, root: ObjectSpan): string => {
	const first = root.members[0];
	if (first === undefined) return DEFAULT_INDENT;
	const step = lineIndent(text, first.keyStart).slice(lineIndent(text, root.close).length);
	return step === "" ? DEFAULT_INDENT : step;
};

/** `keys` nested around `value`: `["a", "b"]` over `1` is `{a: {b: 1}}`. */
const nest = (keys: ReadonlyArray<string>, value: unknown): unknown =>
	keys.reduceRight((inner, key) => ({[key]: inner}), value);

/**
 * A new last member for `object`. A comma goes straight after the member before it, so a comment
 * trailing that member stays attached to it rather than moving under the new one.
 */
const appendMember = (
	text: string,
	object: ObjectSpan,
	key: string,
	value: unknown,
	unit: string,
): string => {
	const base = lineIndent(text, object.close);
	const indent = `${base}${unit}`;
	const last = object.members.at(-1);
	const head = last === undefined ? text.slice(0, object.open + 1) : `${text.slice(0, last.end)},`;
	const kept = text.slice(last?.end ?? object.open + 1, object.close).trimEnd();
	const member = `${JSON.stringify(key)}: ${render(value, indent, unit)}`;
	return `${head}${kept}\n${indent}${member}\n${base}${text.slice(object.close)}`;
};

type KeyPath = readonly [string, ...ReadonlyArray<string>];

const setIn = (
	text: string,
	object: ObjectSpan,
	walked: ReadonlyArray<string>,
	[key, ...rest]: KeyPath,
	value: unknown,
	unit: string,
): JsoncEdit => {
	const member = object.members.find((candidate) => candidate.key === key);
	if (member === undefined) {
		return {_tag: "Edited", text: appendMember(text, object, key, nest(rest, value), unit)};
	}
	const [next, ...deeper] = rest;
	if (next === undefined) {
		const rendered = render(value, lineIndent(text, member.keyStart), unit);
		return {
			_tag: "Edited",
			text: `${text.slice(0, member.start)}${rendered}${text.slice(member.end)}`,
		};
	}
	const inner = objectAt(text, member.start);
	return inner === null
		? {_tag: "Refused", reason: `"${[...walked, key].join(".")}" is not an object`}
		: setIn(text, inner, [...walked, key], [next, ...deeper], value, unit);
};

/**
 * Set the value at `path` to `value`.
 *
 * A member already there has its value replaced; a missing one is appended to the deepest object the
 * path reaches, carrying whatever of the path is left. A step through a value that is not an object
 * is refused: replacing it would delete something the path never named.
 */
export const setJsoncValue = (text: string, path: KeyPath, value: unknown): JsoncEdit => {
	const root = objectAt(text, skipTrivia(text, 0));
	return root === null
		? {_tag: "Refused", reason: "the document is not a JSON object"}
		: setIn(text, root, [], path, value, indentUnit(text, root));
};
