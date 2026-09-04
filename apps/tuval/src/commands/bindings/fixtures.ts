/**
 * Real spells for the binding tests.
 *
 * The parser's own fixtures hand-write the JSON Schema a `SpellDescription` carries; these are
 * whole spells with executable `params`, because compiling a binding decodes its arguments against
 * that schema and a description alone cannot prove the decoded value differs from the token text.
 */

import {Effect, Schema} from "effect";
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
];

export const registry = (only: ReadonlyArray<AnySpell> = spells): Effect.Effect<RegistryTable> =>
	buildRegistry({core: only, programs: []}).pipe(Effect.orDie);
