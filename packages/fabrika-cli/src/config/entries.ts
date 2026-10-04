/** Decoding pieces several key modules share. */

import {isRecord} from "../io/json.ts";
import type {Decoded} from "./key-group.ts";

/**
 * An array of non-empty strings, trimmed, or `null` when any entry is not one.
 *
 * `null` rather than a partial list: a malformed entry refuses its key's whole value everywhere on
 * this surface, because a typo'd entry silently dropped is a declaration the operator believes is
 * configured and is not, which surfaces only as a verdict nobody can explain.
 */
export const trimmedStrings = (raw: unknown): ReadonlyArray<string> | null => {
	if (!Array.isArray(raw)) return null;
	const values: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.trim() === "") return null;
		values.push(entry.trim());
	}
	return values;
};

/** An argv whose head is the binary, so a caller cannot spawn an empty command. */
export type Argv = readonly [string, ...ReadonlyArray<string>];

/**
 * One declared validator that opens a fixed set of files: the command to spawn, plus those files.
 *
 * `reads` is what makes a green checkable per file. A declared validator takes no path arguments,
 * so without it the verb can only prove that *something* ran, and a diff touching a file nobody
 * opens greens with an empty `unvalidated` list.
 */
export interface ReadingValidator {
	readonly argv: Argv;
	readonly reads: ReadonlyArray<string>;
}

/**
 * The `{"command": [argv], "reads": [paths]}` list grammar, for every key that declares one.
 *
 * One decoder rather than one per key, so two keys spelled the same in the file cannot drift into
 * accepting different things. `malformed` is the key's own refusal line, naming its example.
 */
export const readingValidators = (
	key: string,
	raw: unknown,
	malformed: string,
): Decoded<ReadonlyArray<ReadingValidator>> => {
	if (!Array.isArray(raw)) return {_tag: "Malformed", reason: `\`${key}\` is not an array`};
	const refused = {_tag: "Malformed", reason: malformed} as const;
	const validators: ReadingValidator[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) return refused;
		const command = trimmedStrings(entry.command);
		const reads = trimmedStrings(entry.reads);
		if (command === null || reads === null || reads.length === 0) return refused;
		const [binary, ...args] = command;
		if (binary === undefined) return refused;
		validators.push({argv: [binary, ...args], reads});
	}
	return {_tag: "Value", value: validators};
};

/** How a {@link ReadingValidator} list prints: the file's key is `command`, not the spawn's `argv`. */
export const renderReadingValidators = (
	validators: ReadonlyArray<ReadingValidator>,
): ReadonlyArray<{
	readonly command: ReadonlyArray<string>;
	readonly reads: ReadonlyArray<string>;
}> => validators.map((one) => ({command: [...one.argv], reads: [...one.reads]}));
