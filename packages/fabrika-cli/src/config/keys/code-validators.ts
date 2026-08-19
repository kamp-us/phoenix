/**
 * `codeValidators` — the repo's own commands that compile and lint its code.
 *
 * Declared rather than compiled in, because the script names and their cache-bypass flags are the
 * repo's own: `lint:worktree` is a phoenix script name, and `--force` is turbo's flag, which a bare
 * `tsc` rejects outright (#6015). An argv array rather than a command line, and the `command` key
 * `workflowValidators` already uses, so the file has one grammar for "a command fabrika spawns".
 *
 * No `reads`. On the workflow surface that field is what makes a green checkable per file, because
 * a declared guard opens a fixed set it names; a code validator is handed no paths and compiles the
 * tree, so a per-file list here would be a claim nothing could hold it to.
 *
 * **The shipped default is empty, and phoenix declares its own pair like any other repo.** Emptiness
 * costs nothing here that it costs a gate-scope key: an empty list has nothing runnable, so
 * `build check --surface code` refuses UNKNOWN on it — never green, and never `VALIDATION_RED`,
 * which stays reserved for a validator that ran and failed. Defaulting to phoenix's pair instead
 * left an adopting repo running script names it never defined: demlik declared nothing, got
 * `pnpm typecheck --force`, and `tsc` rejected the turbo flag outright — a red saying its code was
 * broken when the truth was that no validator was present (#6015).
 */

import {isRecord} from "../../io/json.ts";
import {trimmedStrings} from "../entries.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";
import type {Argv} from "./workflow-validators.ts";

export const CODE_VALIDATORS = "codeValidators";

/** One declared validator: the command to spawn. Its label in a verdict is the joined argv. */
export interface CodeValidator {
	readonly argv: Argv;
}

const MALFORMED = `\`${CODE_VALIDATORS}\` holds an entry that is not {"command": [non-empty argv of strings]} — e.g. {"command": ["pnpm", "typecheck"]}`;

const decode = (raw: unknown): Decoded<ReadonlyArray<CodeValidator>> => {
	if (!Array.isArray(raw)) {
		return {_tag: "Malformed", reason: `\`${CODE_VALIDATORS}\` is not an array`};
	}
	const malformed: Decoded<ReadonlyArray<CodeValidator>> = {_tag: "Malformed", reason: MALFORMED};
	const validators: CodeValidator[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) return malformed;
		const command = trimmedStrings(entry.command);
		if (command === null) return malformed;
		const [binary, ...args] = command;
		if (binary === undefined) return malformed;
		validators.push({argv: [binary, ...args]});
	}
	return {_tag: "Value", value: validators};
};

/** A repo declaring nothing has no code validator — the refusal, not a guessed command line. */
export const SHIPPED_CODE_VALIDATORS: ReadonlyArray<CodeValidator> = [];

export const codeValidatorsKey: KeyGroup<ReadonlyArray<CodeValidator>> = {
	key: CODE_VALIDATORS,
	shippedDefault: SHIPPED_CODE_VALIDATORS,
	decode,
	// `argv` is the spawn shape; the file's key is `command`, and a readout prints what the repo wrote.
	render: (validators) => validators.map((one) => ({command: [...one.argv]})),
};
