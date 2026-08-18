/**
 * The repo's own fabrika configuration — `.fabrika.jsonc` at the repository root.
 *
 * Today it answers exactly one question: **who may clear a repair round** (#5959, ruled 2026-08-18
 * — "'founder' concept can change repo by repo, let's make it a configuration? it can be an array
 * of github usernames and github teams"). The file is the home epic #5631 names for every value
 * that is a literal in source today; this module opens it for the one key that has a ruling and
 * leaves the rest of the surface to that epic.
 *
 * **Fail-closed on every axis.** An absent file, an absent key, an empty array and a malformed
 * entry all resolve to *nobody may grant* rather than to a default set — a config that silently
 * widened who holds founder authority is the one failure this key cannot have. A read that failed
 * resolves to neither: it is UNKNOWN, and the caller refuses on it.
 */

import {isRecord, parseJson} from "./io/json.ts";

/** The file, at the repository root. Read at a base ref, never from the working tree (#981). */
export const CONFIG_PATH = ".fabrika.jsonc";

/** The key naming the accounts and teams that may clear a repair round. */
export const CAP_CLEAR_AUTHORS = "capClearAuthors";

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

/** One entry of the grant-author set: a `@login`, or a `@org/team` whose membership is resolved. */
export type GrantAuthor =
	| {readonly _tag: "User"; readonly login: string}
	| {readonly _tag: "Team"; readonly org: string; readonly team: string};

export type AuthorsRead =
	| {readonly _tag: "Authors"; readonly authors: ReadonlyArray<GrantAuthor>}
	/** The bytes were read in full and hold no usable set — nobody may grant. */
	| {readonly _tag: "Unusable"; readonly reason: string};

const USER = /^@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)$/;
const TEAM = /^@([^/\s]+)\/([^/\s]+)$/;

/**
 * The grant-author set the config declares. Every rejection names what it rejected.
 *
 * An entry that is not a `@`-prefixed user or `@org/team` refuses the **whole** set rather than
 * being skipped: a typo'd entry silently dropped is an author the operator believes is configured
 * and is not, which surfaces only as a refused grant nobody can explain.
 */
export const readCapClearAuthors = (text: string): AuthorsRead => {
	const parsed = parseJson(stripJsonComments(text));
	if (!isRecord(parsed)) {
		return {_tag: "Unusable", reason: `${CONFIG_PATH} is not a JSON object with comments`};
	}
	const raw = parsed[CAP_CLEAR_AUTHORS];
	if (raw === undefined) {
		return {_tag: "Unusable", reason: `${CONFIG_PATH} declares no \`${CAP_CLEAR_AUTHORS}\``};
	}
	if (!Array.isArray(raw)) {
		return {_tag: "Unusable", reason: `\`${CAP_CLEAR_AUTHORS}\` is not an array`};
	}
	const authors: GrantAuthor[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") {
			return {
				_tag: "Unusable",
				reason: `\`${CAP_CLEAR_AUTHORS}\` holds a non-string entry — expected "@user" or "@org/team"`,
			};
		}
		const value = entry.trim();
		const team = TEAM.exec(value);
		if (team?.[1] !== undefined && team[2] !== undefined) {
			authors.push({_tag: "Team", org: team[1], team: team[2]});
			continue;
		}
		const user = USER.exec(value);
		if (user?.[1] !== undefined) {
			authors.push({_tag: "User", login: user[1]});
			continue;
		}
		return {
			_tag: "Unusable",
			reason: `"${entry}" is not a \`${CAP_CLEAR_AUTHORS}\` entry — expected "@user" or "@org/team"`,
		};
	}
	return authors.length === 0
		? {_tag: "Unusable", reason: `\`${CAP_CLEAR_AUTHORS}\` is empty — nobody may clear a round`}
		: {_tag: "Authors", authors};
};
