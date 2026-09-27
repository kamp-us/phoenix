/**
 * `configValidators` — the repo's own commands that machine-read a file no `build check` surface
 * opens: a root config file such as `lefthook.yml`, or non-JS source such as a `.java` file under a
 * Gradle tree. One key serves both, so native source gets no second mechanism.
 *
 * The `workflowValidators` grammar, decoded by the same {@link readingValidators}: the command that
 * validates a config file is the repo's own tool, and a second key costs one registry line where
 * generalizing the first would change what every adopting repo already wrote.
 *
 * `reads` is a list of exact repo-relative paths, never a pattern. A declared command opens a fixed
 * set of files, and a pattern would let an entry claim files the command never opens — the false
 * green `reads` exists to prevent. So a glob metacharacter in `reads` refuses the whole value.
 *
 * The shipped default is the empty list, which leaves every such file unvalidatable. This key is not
 * machine-local overridable: it decides what `build check` validates, and a local override would be
 * an untracked way to shrink that.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/6913#issuecomment-5519863564
 */

import {type ReadingValidator, readingValidators, renderReadingValidators} from "../entries.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const CONFIG_VALIDATORS = "configValidators";

export type ConfigValidator = ReadingValidator;

const MALFORMED = `\`${CONFIG_VALIDATORS}\` holds an entry that is not {"command": [non-empty argv of strings], "reads": [non-empty list of exact repo-relative paths]} — e.g. {"command": ["pnpm", "exec", "lefthook", "validate"], "reads": ["lefthook.yml"]}`;

const GLOB = /[*?[\]{}]/;

const decode = (raw: unknown): Decoded<ReadonlyArray<ConfigValidator>> => {
	const decoded = readingValidators(CONFIG_VALIDATORS, raw, MALFORMED);
	if (decoded._tag === "Malformed") return decoded;
	const pattern = decoded.value.flatMap((one) => one.reads).find((path) => GLOB.test(path));
	return pattern === undefined
		? decoded
		: {
				_tag: "Malformed",
				reason: `\`${CONFIG_VALIDATORS}\` reads "${pattern}", a pattern — \`reads\` names exact repo-relative paths, never a glob`,
			};
};

export const configValidatorsKey: KeyGroup<ReadonlyArray<ConfigValidator>> = {
	key: CONFIG_VALIDATORS,
	shippedDefault: [],
	decode,
	render: renderReadingValidators,
	jsonSchema: {
		type: "array",
		description:
			"The repo's own commands that machine-read a file no `build check` surface opens — a root config file such as lefthook.yml, or non-JS source such as a .java file — every `build check` run whose diff touches a file an entry reads spawns that entry, whatever `--surface` names. Empty (or absent) leaves such files unvalidatable.",
		items: {
			type: "object",
			properties: {
				command: {
					type: "array",
					description: 'The argv to spawn — e.g. ["pnpm", "exec", "lefthook", "validate"].',
					items: {type: "string"},
					minItems: 1,
				},
				reads: {
					type: "array",
					description:
						"The exact repo-relative files this command opens, never a glob — what makes a passing run checkable per file.",
					items: {type: "string", minLength: 1, pattern: "^[^*?\\[\\]{}]+$"},
					minItems: 1,
				},
			},
			required: ["command", "reads"],
			additionalProperties: false,
		},
	},
};
