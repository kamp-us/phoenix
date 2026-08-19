/**
 * `workflowValidators` — the repo's own commands that machine-read `.github/workflows/**`.
 *
 * Declared rather than compiled in, because the commands that machine-read a repo's workflows are
 * that repo's own and fabrika installs into repos it does not control (ADR 0273). An argv array
 * rather than a command line: fabrika spawns it directly, and splitting a string would put a quoting
 * grammar between the config and the process.
 *
 * The shipped default is the empty list — **this repo declares none** — and `build check --surface
 * workflows` then stands on `actionlint` alone, refusing UNKNOWN where no changed workflow was
 * opened at all.
 */

import {isRecord} from "../../io/json.ts";
import {trimmedStrings} from "../entries.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const WORKFLOW_VALIDATORS = "workflowValidators";

/** An argv whose head is the binary, so a caller cannot spawn an empty command. */
export type Argv = readonly [string, ...ReadonlyArray<string>];

/**
 * One declared validator: the command to spawn, plus the workflow files it opens.
 *
 * `reads` is what makes the surface's green checkable per file. A declared guard takes no path
 * arguments — it reads a fixed set — so without this the verb can only prove that *something* ran,
 * and a diff touching a workflow nobody opens greens with an empty `unvalidated` list (#5991).
 */
export interface WorkflowValidator {
	readonly argv: Argv;
	readonly reads: ReadonlyArray<string>;
}

const MALFORMED = `\`${WORKFLOW_VALIDATORS}\` holds an entry that is not {"command": [non-empty argv of strings], "reads": [non-empty list of workflow paths]} — e.g. {"command": ["node", "tools/lint-workflows.js"], "reads": [".github/workflows/ci.yml"]}`;

const decode = (raw: unknown): Decoded<ReadonlyArray<WorkflowValidator>> => {
	if (!Array.isArray(raw)) {
		return {_tag: "Malformed", reason: `\`${WORKFLOW_VALIDATORS}\` is not an array`};
	}
	const malformed: Decoded<ReadonlyArray<WorkflowValidator>> = {
		_tag: "Malformed",
		reason: MALFORMED,
	};
	const validators: WorkflowValidator[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) return malformed;
		const command = trimmedStrings(entry.command);
		const reads = trimmedStrings(entry.reads);
		if (command === null || reads === null || reads.length === 0) return malformed;
		const [binary, ...args] = command;
		if (binary === undefined) return malformed;
		validators.push({argv: [binary, ...args], reads});
	}
	return {_tag: "Value", value: validators};
};

export const workflowValidatorsKey: KeyGroup<ReadonlyArray<WorkflowValidator>> = {
	key: WORKFLOW_VALIDATORS,
	shippedDefault: [],
	decode,
};
