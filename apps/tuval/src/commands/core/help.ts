/**
 * `help`: the spell table, rendered from every spell's own `describe` (#7617 R2.1, R2.4).
 *
 * There is no help text anywhere in this file. A row is built from the registry's own
 * `SpellDescription` — the same serializable value a `Snapshot` carries and the palette's inline
 * description reads — so a spell's sentence is written once, at its `defineSpell` site, and every
 * surface that shows it shows the same string.
 *
 * `usage` is derived the same way: the description's `params` arrive as JSON Schema, the parser's
 * `readParams` flattens them to the positional list, and `describeExpected` renders each slot — the
 * one already shared by the palette and the parser's refusals.
 */

import {Effect, Schema} from "effect";
import type {RegistryDescription} from "../../protocol/registry-description.ts";
import {UnknownSpell} from "../errors.ts";
import {didYouMean} from "../parse/did-you-mean.ts";
import {describeExpected, type ParamSpec, readParams} from "../parse/spell-index.ts";
import {SpellRegistry} from "../registry.ts";
import {defineSpell} from "../spell.ts";

/** One line of the table: the spell's address, what it expects, and its own sentence. */
export const HelpRow = Schema.Struct({
	path: Schema.String,
	usage: Schema.String,
	describe: Schema.String,
});
export type HelpRow = typeof HelpRow.Type;

export const HelpRows = Schema.Array(HelpRow);

/**
 * A path as a person types it. Both separators are accepted because both are in use: the palette
 * reads spaces (`window close`) and a refusal renders dots (`window.close`).
 */
export const segmentsOf = (path: string): ReadonlyArray<string> =>
	path.split(/[\s.]+/).filter((segment) => segment.length > 0);

const renderUsage = (params: ReadonlyArray<ParamSpec>): string =>
	params
		.map((param) => (param.required ? describeExpected(param) : `[${describeExpected(param)}]`))
		.join(" ");

/** Every address the table answers to, including each group along the way — `help`'s candidates. */
const addresses = (descriptions: RegistryDescription): ReadonlyArray<string> => {
	const seen = new Set<string>();
	for (const description of descriptions) {
		const walked: Array<string> = [];
		for (const segment of description.path) {
			walked.push(segment);
			seen.add(walked.join(" "));
		}
	}
	return [...seen];
};

/**
 * The rows under one prefix, every spell once. Sorting on the space-joined path is the grouping:
 * a space orders before any segment character, so a group's own spells stay together and sorted.
 */
export const helpRows = (
	descriptions: RegistryDescription,
	prefix: ReadonlyArray<string>,
): ReadonlyArray<HelpRow> =>
	descriptions
		.filter((description) => prefix.every((segment, index) => description.path[index] === segment))
		.map((description) => ({
			path: description.path.join(" "),
			usage: renderUsage(readParams(description.params)),
			describe: description.describe,
		}))
		.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

const GAP = 3;

/** The aligned text the palette and the status line show. Describes start at one column. */
export const renderHelp = (rows: ReadonlyArray<HelpRow>): string => {
	const lines = rows.map((row) => ({
		left: row.usage.length === 0 ? row.path : `${row.path} ${row.usage}`,
		describe: row.describe,
	}));
	const width = lines.reduce((widest, line) => Math.max(widest, line.left.length), 0);
	return lines.map((line) => `${line.left.padEnd(width + GAP)}${line.describe}`).join("\n");
};

export const helpSpell = defineSpell({
	path: ["help"],
	describe: "List every spell, or only the ones under one path.",
	params: Schema.Struct({path: Schema.optionalKey(Schema.String)}),
	result: HelpRows,
	execute: Effect.fn("Tuval.Spells.help")(function* (args: {readonly path?: string}) {
		const registry = yield* SpellRegistry;
		const descriptions = yield* registry.describe;
		const prefix = args.path === undefined ? [] : segmentsOf(args.path);
		const rows = helpRows(descriptions, prefix);
		if (rows.length > 0 || prefix.length === 0) return rows;
		// An empty answer to a typed path is a dead end, so the miss reads like every other one.
		const asked = prefix.join(" ");
		const suggestion = didYouMean(asked, addresses(descriptions));
		return yield* new UnknownSpell({
			path: asked,
			...(suggestion === undefined ? {} : {didYouMean: suggestion}),
		});
	}),
	capabilities: [],
});
