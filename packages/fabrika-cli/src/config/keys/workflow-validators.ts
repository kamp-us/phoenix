/**
 * `workflowValidators` — the repo's own commands that machine-read `.github/workflows/**`.
 *
 * Declared rather than compiled in, because the commands that machine-read a repo's workflows are
 * that repo's own and fabrika installs into repos it does not control. An argv array
 * rather than a command line: fabrika spawns it directly, and splitting a string would put a quoting
 * grammar between the config and the process.
 *
 * The shipped default is the empty list — **this repo declares none** — and `build check --surface
 * workflows` then stands on `actionlint` alone, refusing UNKNOWN where no changed workflow was
 * opened at all.
 */

import {type ReadingValidator, readingValidators, renderReadingValidators} from "../entries.ts";
import type {KeyGroup} from "../key-group.ts";

export type {Argv} from "../entries.ts";

export const WORKFLOW_VALIDATORS = "workflowValidators";

/** One declared validator: the command to spawn, plus the workflow files it opens. */
export type WorkflowValidator = ReadingValidator;

const MALFORMED = `\`${WORKFLOW_VALIDATORS}\` holds an entry that is not {"command": [non-empty argv of strings], "reads": [non-empty list of workflow paths]} — e.g. {"command": ["node", "tools/lint-workflows.js"], "reads": [".github/workflows/ci.yml"]}`;

export const workflowValidatorsKey: KeyGroup<ReadonlyArray<WorkflowValidator>> = {
	key: WORKFLOW_VALIDATORS,
	shippedDefault: [],
	decode: (raw) => readingValidators(WORKFLOW_VALIDATORS, raw, MALFORMED),
	render: renderReadingValidators,
	jsonSchema: {
		type: "array",
		description:
			"The repo's own commands that machine-read `.github/workflows/**` — `build check --surface workflows` spawns each. Empty (or absent) stands on actionlint alone.",
		items: {
			type: "object",
			properties: {
				command: {
					type: "array",
					description: 'The argv to spawn — e.g. ["node", "tools/lint-workflows.js"].',
					items: {type: "string"},
					minItems: 1,
				},
				reads: {
					type: "array",
					description:
						"The exact workflow files this command opens — what makes a passing run checkable per file.",
					items: {type: "string", minLength: 1},
					minItems: 1,
				},
			},
			required: ["command", "reads"],
			additionalProperties: false,
		},
	},
};
