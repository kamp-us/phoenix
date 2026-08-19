/**
 * The repo's own fabrika configuration — `.fabrika.jsonc` at the repository root.
 *
 * It answers three questions. **Who may clear a repair round** (#5959, ruled 2026-08-18 — "'founder'
 * concept can change repo by repo, let's make it a configuration? it can be an array of github
 * usernames and github teams"), **which docs are exempt from `build check`'s leak scan** —
 * repo policy for the same reason, since the docs whose subject is path hygiene differ repo by repo
 * and fabrika installs into repos that are not phoenix (ADR 0273) — and **which of the repo's own
 * commands validate its workflow YAML**, which is that repo's fleet of guards and nobody else's.
 * The file is the home epic #5631
 * names for every value that is a literal in source today; this module opens it for the keys that
 * have a ruling and leaves the rest of the surface to that epic.
 *
 * **Fail-closed on every axis.** An absent file, an absent key, an empty array and a malformed
 * entry all resolve to *nobody may grant* rather than to a default set — a config that silently
 * widened who holds founder authority is the one failure this key cannot have. A read that failed
 * resolves to neither: it is UNKNOWN, and the caller refuses on it. The exempt list closes the same
 * way: unusable means *nothing is exempt*, so the scanner stays at its strictest.
 */

import {isRecord, parseJson} from "./io/json.ts";

/** The file, at the repository root. Read at a base ref, never from the working tree (#981). */
export const CONFIG_PATH = ".fabrika.jsonc";

/** The key naming the accounts and teams that may clear a repair round. */
export const CAP_CLEAR_AUTHORS = "capClearAuthors";

/** The key naming the docs whose subject IS path hygiene, exempt from `build check`'s leak scan. */
export const DOC_LEAK_EXEMPT = "docLeakExempt";

/** The key naming the repo's own commands that machine-read `.github/workflows/**`. */
export const WORKFLOW_VALIDATORS = "workflowValidators";

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

export type ExemptRead =
	| {readonly _tag: "Paths"; readonly paths: ReadonlyArray<string>}
	/** The bytes were read in full and hold no usable list — nothing is exempt. */
	| {readonly _tag: "Unusable"; readonly reason: string};

/**
 * The docs the repo declares exempt from `build check`'s leak scan, as repo-relative path suffixes.
 *
 * A malformed entry refuses the **whole** list rather than being skipped, for the reason the
 * grant-author set does it: a typo'd entry silently dropped is an exemption the operator believes is
 * configured and is not, which surfaces only as a red nobody can explain. Refusing the list leaves
 * the scanner at its strictest, so the failure is loud rather than permissive.
 */
export const readDocLeakExempt = (text: string): ExemptRead => {
	const parsed = parseJson(stripJsonComments(text));
	if (!isRecord(parsed)) {
		return {_tag: "Unusable", reason: `${CONFIG_PATH} is not a JSON object with comments`};
	}
	const raw = parsed[DOC_LEAK_EXEMPT];
	if (raw === undefined) {
		return {_tag: "Unusable", reason: `${CONFIG_PATH} declares no \`${DOC_LEAK_EXEMPT}\``};
	}
	if (!Array.isArray(raw)) {
		return {_tag: "Unusable", reason: `\`${DOC_LEAK_EXEMPT}\` is not an array`};
	}
	const paths: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.trim() === "") {
			return {
				_tag: "Unusable",
				reason: `\`${DOC_LEAK_EXEMPT}\` holds an entry that is not a non-empty string — expected a repo-relative path`,
			};
		}
		paths.push(entry.trim());
	}
	return paths.length === 0
		? {_tag: "Unusable", reason: `\`${DOC_LEAK_EXEMPT}\` is empty — nothing is exempt`}
		: {_tag: "Paths", paths};
};

/** An argv whose head is the binary, so a caller cannot spawn an empty command. */
export type Argv = readonly [string, ...ReadonlyArray<string>];

export type ValidatorsRead =
	| {readonly _tag: "Validators"; readonly commands: ReadonlyArray<Argv>}
	/** The bytes were read in full and hold no usable list — the repo declares no validator. */
	| {readonly _tag: "Unusable"; readonly reason: string};

/**
 * The commands the repo declares as validators of its own workflow YAML, each an argv array.
 *
 * Declared rather than compiled in, because the commands that machine-read a repo's workflows are
 * that repo's own — in phoenix three `pipeline-cli` guards — and fabrika installs into repos it does
 * not control (ADR 0273). An argv array rather than a command line: fabrika spawns it directly, and
 * splitting a string would put a quoting grammar between the config and the process.
 *
 * A malformed entry refuses the **whole** list, the way the other two keys do. Here that is the loud
 * direction as well as the consistent one: `build check --surface workflows` refuses UNKNOWN when no
 * validator ran at all, so a dropped entry surfaces as a refusal rather than as a green standing on
 * fewer validators than the operator declared.
 */
export const readWorkflowValidators = (text: string): ValidatorsRead => {
	const parsed = parseJson(stripJsonComments(text));
	if (!isRecord(parsed)) {
		return {_tag: "Unusable", reason: `${CONFIG_PATH} is not a JSON object with comments`};
	}
	const raw = parsed[WORKFLOW_VALIDATORS];
	if (raw === undefined) {
		return {_tag: "Unusable", reason: `${CONFIG_PATH} declares no \`${WORKFLOW_VALIDATORS}\``};
	}
	if (!Array.isArray(raw)) {
		return {_tag: "Unusable", reason: `\`${WORKFLOW_VALIDATORS}\` is not an array`};
	}
	const malformed: ValidatorsRead = {
		_tag: "Unusable",
		reason: `\`${WORKFLOW_VALIDATORS}\` holds an entry that is not a non-empty array of strings — expected an argv, e.g. ["node", "tools/lint-workflows.js"]`,
	};
	const commands: Argv[] = [];
	for (const entry of raw) {
		if (!Array.isArray(entry)) return malformed;
		const parts: string[] = [];
		for (const part of entry) {
			if (typeof part !== "string") return malformed;
			parts.push(part);
		}
		const [binary, ...args] = parts;
		if (binary === undefined) return malformed;
		commands.push([binary, ...args]);
	}
	return commands.length === 0
		? {_tag: "Unusable", reason: `\`${WORKFLOW_VALIDATORS}\` is empty — this repo declares none`}
		: {_tag: "Validators", commands};
};
