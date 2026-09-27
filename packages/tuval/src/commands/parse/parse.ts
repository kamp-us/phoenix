/**
 * The parser's public face: total, synchronous, and never throwing, because the page runs it on
 * every keystroke and the kernel runs it over the key bindings at config load (the founder's
 * 2026-09-03 walk on #7639). The rules it applies live in `reading.ts`.
 */

import type {Snapshot} from "../../protocol/messages.ts";
import type {SpellPath} from "../spell.ts";
import {type Candidate, candidatesFor} from "./complete.ts";
import {read} from "./reading.ts";
import type {IndexedSpell, ParamSpec, SpellIndex} from "./spell-index.ts";

/**
 * The `SpellCall` fields a line can determine. The correlation id and the calling window are the
 * caller's, so they are not here: the page mints an id and names its window, the kernel neither.
 *
 * `args` holds token text. The executor decodes it against the spell's own `params`; the parser's
 * only value check is an enum parameter's literals.
 */
export interface SpellCallDraft {
	readonly path: SpellPath;
	readonly args: Readonly<Record<string, string>>;
}

export type ParseResult =
	| {readonly _tag: "Complete"; readonly call: SpellCallDraft}
	| {
			readonly _tag: "Partial";
			/** The spell the line has already named, when it has named one. */
			readonly spell?: IndexedSpell;
			/** The parameter the caret is on, or the next one the line still owes. */
			readonly cursorArg?: ParamSpec;
			readonly candidates: ReadonlyArray<Candidate>;
	  }
	| {
			readonly _tag: "Refused";
			/** Offset of the offending token's first character in the input. */
			readonly position: number;
			readonly expected: string;
			readonly didYouMean?: string;
	  };

export const parse = (input: string, registry: SpellIndex, snapshot: Snapshot): ParseResult => {
	const {core, slot} = read(input, registry);
	if (core.kind === "Complete") {
		return {_tag: "Complete", call: {path: core.spell.path, args: core.args}};
	}
	if (core.kind === "Refused") {
		return core.didYouMean === undefined
			? {_tag: "Refused", position: core.position, expected: core.expected}
			: {
					_tag: "Refused",
					position: core.position,
					expected: core.expected,
					didYouMean: core.didYouMean,
				};
	}
	const candidates = candidatesFor(slot, snapshot);
	if (core.spell === undefined) return {_tag: "Partial", candidates};
	return core.cursorArg === undefined
		? {_tag: "Partial", spell: core.spell, candidates}
		: {_tag: "Partial", spell: core.spell, cursorArg: core.cursorArg, candidates};
};
