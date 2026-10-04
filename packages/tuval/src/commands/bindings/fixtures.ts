/**
 * Real spells for the binding tests.
 *
 * The parser's own fixtures hand-write the JSON Schema a `SpellDescription` carries; these are
 * whole spells with executable `params`, because compiling a binding decodes its arguments against
 * that schema and a description alone cannot prove the decoded value differs from the token text.
 */

import {Effect, Schema, SchemaTransformation} from "effect";
import {buildRegistry, type RegistryTable} from "../registry.ts";
import {type AnySpell, defineSpell} from "../spell.ts";

const spell = (
	path: readonly [string, ...ReadonlyArray<string>],
	describe: string,
	params: Schema.Top,
): AnySpell =>
	defineSpell({
		path,
		describe,
		params,
		result: Schema.Void,
		execute: () => Effect.void,
		capabilities: [],
	});

/**
 * The two spells whose `params` reach past one level. A parameter is always bound to a whole token,
 * so a nesting only exists where the schema reads a structure out of that token's text: these split
 * `"3,4"` on the comma, and a bad half then fails at `at.row` or at `sizes[1]` rather than at the
 * parameter itself. Both separators `renderPath` emits are covered, `.` and `[`.
 *
 * Each takes a plain `workspace` first so the nested parameter is never the first argument token:
 * a lookup that misses falls back to that first token, which would otherwise be the right answer
 * by accident and grade a broken caret green.
 */
const numbers = (text: string): ReadonlyArray<number> => text.split(",").map(Number);

const Point = Schema.String.pipe(
	Schema.decodeTo(
		Schema.Struct({column: Schema.Finite, row: Schema.Finite}),
		SchemaTransformation.transform({
			decode: (text: string) => {
				const [column = Number.NaN, row = Number.NaN] = numbers(text);
				return {column, row};
			},
			encode: (point: {column: number; row: number}) => `${point.column},${point.row}`,
		}),
	),
);

const Sizes = Schema.String.pipe(
	Schema.decodeTo(
		Schema.Array(Schema.Finite),
		SchemaTransformation.transform({
			decode: numbers,
			encode: (sizes: ReadonlyArray<number>) => sizes.join(","),
		}),
	),
);

export const spells: ReadonlyArray<AnySpell> = [
	spell(["window", "close"], "Close the focused window.", Schema.Struct({})),
	spell(
		["window", "swap"],
		"Swap the focused window with its neighbour.",
		Schema.Struct({direction: Schema.Literals(["left", "right", "up", "down"])}),
	),
	spell(
		["window", "grow"],
		"Grow the focused window.",
		// The one parameter whose decoded value differs from the token text: the config author
		// writes `window grow 3` and the router must be handed the number 3.
		Schema.Struct({columns: Schema.FiniteFromString}),
	),
	spell(
		["workspace", "activate"],
		"Switch to a workspace.",
		Schema.Struct({workspace: Schema.String}),
	),
	spell(["workspace", "next"], "Switch to the next workspace.", Schema.Struct({})),
	spell(
		["window", "place"],
		"Move a workspace's focused window to a cell.",
		Schema.Struct({workspace: Schema.String, at: Point}),
	),
	spell(
		["window", "fit"],
		"Resize a workspace's focused window.",
		Schema.Struct({workspace: Schema.String, sizes: Sizes}),
	),
];

export const registry = (only: ReadonlyArray<AnySpell> = spells): Effect.Effect<RegistryTable> =>
	buildRegistry({core: only, programs: []}).pipe(Effect.orDie);
