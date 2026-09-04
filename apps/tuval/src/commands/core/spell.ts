/**
 * `spell list` and `spell describe`: the registry as a process reads it (#7617 R2.1).
 *
 * `help` renders the table for a person; these two hand the same table to a program. An AI agent
 * driving Tuval discovers what it can call over exactly the wire a human's palette uses — one
 * registry, one description, no second catalogue to keep in step (the founder's 2026-09-03 ruling
 * on #7641).
 */

import {Effect, Schema} from "effect";
import {RegistryDescription, SpellDescription} from "../../protocol/registry-description.ts";
import {UnknownSpell} from "../errors.ts";
import {didYouMean} from "../parse/did-you-mean.ts";
import {SpellRegistry} from "../registry.ts";
import {defineSpell} from "../spell.ts";
import {segmentsOf} from "./help.ts";

export const spellList = defineSpell({
	path: ["spell", "list"],
	describe: "Describe every registered spell, for a program to read.",
	params: Schema.Struct({}),
	result: RegistryDescription,
	execute: Effect.fn("Tuval.Spells.spellList")(function* () {
		const registry = yield* SpellRegistry;
		return yield* registry.describe;
	}),
	capabilities: [],
});

export const spellDescribe = defineSpell({
	path: ["spell", "describe"],
	describe: "Describe one spell, including the schema of its parameters.",
	params: Schema.Struct({path: Schema.String}),
	result: SpellDescription,
	execute: Effect.fn("Tuval.Spells.spellDescribe")(function* (args: {readonly path: string}) {
		const registry = yield* SpellRegistry;
		const descriptions = yield* registry.describe;
		const asked = segmentsOf(args.path).join(" ");
		const found = descriptions.find((description) => description.path.join(" ") === asked);
		if (found !== undefined) return found;
		const suggestion = didYouMean(
			asked,
			descriptions.map((description) => description.path.join(" ")),
		);
		return yield* new UnknownSpell({
			path: asked,
			...(suggestion === undefined ? {} : {didYouMean: suggestion}),
		});
	}),
	capabilities: [],
});
