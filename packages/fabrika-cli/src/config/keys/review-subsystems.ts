/**
 * `reviewSubsystems` — the path globs whose matched files carry an additive review constraint.
 *
 * One row per subsystem: a glob (`pattern`), the subsystem's name, and the constraint text a
 * reviewer applies on top of the class rubric. `review scope` matches the PR's changed files
 * against the patterns and prints a `subsystem` row per subsystem with matches beside its
 * `subsystem-note` — **additive constraints, never a partition**: a path matching several patterns
 * counts under each subsystem, because the rows layer constraints onto the base class rubrics
 * (`code`, `doc`, `skill`, `ui`) rather than carving the diff up.
 *
 * The shipped default is the empty list, and it is the whole point of the key: a repo that declares
 * no subsystems gets exactly the scope output it got before — nothing is opt-out by default, and no
 * constraint text ships for anybody's code.
 *
 * This module ships the key, its default and its decode, and `review scope` reads it through
 * `config/paths.ts`'s `reviewSubsystemsOr`. A key group knows nothing about files, so the matching
 * itself lives in the verb that reads the value, over the one glob grammar the package ships
 * (`review/filter-spike.ts`'s `patternToMatcher` — the same engine the review filter spike uses, so
 * a repo never learns two dialects).
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const REVIEW_SUBSYSTEMS = "reviewSubsystems";

/** One glob-to-constraint row: the files `pattern` matches carry `constraint` under `subsystem`. */
export interface ReviewSubsystem {
	readonly pattern: string;
	readonly subsystem: string;
	readonly constraint: string;
}

/** Empty, and opt-in: no repo inherits another's constraints, and nothing ships by default. */
export const SHIPPED_REVIEW_SUBSYSTEMS: ReadonlyArray<ReviewSubsystem> = [];

const FIELDS = ["pattern", "subsystem", "constraint"] as const;
type Field = (typeof FIELDS)[number];

const fieldRefusal = (index: number, name: Field): string =>
	`"${REVIEW_SUBSYSTEMS}[${index}].${name}" is missing, empty, or not a string`;

const decode = (raw: unknown): Decoded<ReadonlyArray<ReviewSubsystem>> => {
	if (!Array.isArray(raw)) {
		return {
			_tag: "Malformed",
			reason: `\`${REVIEW_SUBSYSTEMS}\` is not an array of {pattern, subsystem, constraint} rows`,
		};
	}
	const rows: ReviewSubsystem[] = [];
	const declared = new Set<string>();
	for (const [index, entry] of raw.entries()) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return {
				_tag: "Malformed",
				reason: `\`${REVIEW_SUBSYSTEMS}\`'s entry ${index} is not an object`,
			};
		}
		const record = entry as Record<string, unknown>;
		const values: Record<Field, string> = {pattern: "", subsystem: "", constraint: ""};
		for (const name of FIELDS) {
			const given = record[name];
			if (typeof given !== "string" || given.trim() === "") {
				return {_tag: "Malformed", reason: fieldRefusal(index, name)};
			}
			values[name] = given.trim();
		}
		// Two rows under one name would make the emitted rows ambiguous — the same `subsystem` line
		// twice with two constraints is a declaration no reader can apply.
		if (declared.has(values.subsystem)) {
			return {
				_tag: "Malformed",
				reason: `two \`${REVIEW_SUBSYSTEMS}\` rows declare the subsystem "${values.subsystem}"`,
			};
		}
		declared.add(values.subsystem);
		rows.push({
			pattern: values.pattern,
			subsystem: values.subsystem,
			constraint: values.constraint,
		});
	}
	return {_tag: "Value", value: rows};
};

const rowSchema = {
	type: "object",
	description:
		"One subsystem: the files its glob matches carry its constraint on top of the class rubric.",
	properties: {
		pattern: {
			type: "string",
			description:
				"The slash-separated glob the subsystem's files match — `*` within one segment, `**` spanning directories.",
			minLength: 1,
		},
		subsystem: {
			type: "string",
			description: "The subsystem's name, unique across the list.",
			minLength: 1,
		},
		constraint: {
			type: "string",
			description:
				"The constraint text a reviewer applies on top of the class rubric, printed verbatim in the scope output.",
			minLength: 1,
		},
	},
	required: ["pattern", "subsystem", "constraint"],
} as const;

export const reviewSubsystemsKey: KeyGroup<ReadonlyArray<ReviewSubsystem>> = {
	key: REVIEW_SUBSYSTEMS,
	shippedDefault: SHIPPED_REVIEW_SUBSYSTEMS,
	decode,
	jsonSchema: {
		type: "array",
		description:
			"The path-glob-to-constraint rows `review scope` layers onto the class rubrics, one row per subsystem. Additive constraints, never a partition: a path matching several patterns counts under each. Empty (or absent) changes nothing.",
		items: rowSchema,
	},
};
