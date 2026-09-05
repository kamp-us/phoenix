/**
 * What the palette lists under the caret, and what accepting a row does to the line.
 *
 * The parser's own `complete` (`../commands/parse/complete.ts`) answers with the *segment* under the
 * caret, which is what a command line wants: one more word to type. A palette wants the runnable
 * thing. So on a path slot this module walks the trie past the matching segment and lists every
 * spell beneath it with its `describe` — typing `win` offers `window close`, `window move` and
 * `window focus`, not the bare word `window`. On a value slot it hands straight back to
 * `candidatesFor`, so a window id or a workspace name still ranks fuzzily on recency (#7617 R1.5).
 *
 * A path slot lists more than the prefix reaches. R1.5's exact-prefix rule is scoped to *completion*
 * — Tab and the `:` line, where `candidatesFor` is untouched — while this listbox also lists a spell
 * whose remaining path or whose sentence merely contains what was typed, so `zoom` finds
 * `window zoom` (the founder's 2026-09-05 ruling on
 * [#8002](https://github.com/kamp-us/phoenix/issues/8002#issuecomment-5554612396)). Three tiers, in
 * this order: an exact prefix on the next segment, then a substring of the rest of the path, then a
 * substring of the sentence.
 *
 * The value half is the founder's earlier ruling unchanged: fuzzy on the values a user named (the
 * 2026-09-03 walk on #7643; ADR 0348, `.patterns/tuval-spells.md`).
 *
 * Everything here is pure and synchronous. The palette runs it on every keystroke against the
 * snapshot the page already holds, and never awaits the kernel to complete (#7617 R1.5).
 */

import type {Candidate} from "../commands/parse/complete.ts";
import {candidatesFor} from "../commands/parse/complete.ts";
import {read} from "../commands/parse/reading.ts";
import type {IndexedSpell, IndexNode, SpellIndex} from "../commands/parse/spell-index.ts";
import type {Token} from "../commands/parse/tokenize.ts";
import {tokenize} from "../commands/parse/tokenize.ts";
import type {Snapshot} from "../protocol/messages.ts";

export type PaletteCandidateKind = "spell" | Candidate["kind"];

export interface PaletteCandidate {
	/** The text that replaces the caret's token when this row is accepted. */
	readonly value: string;
	/** What the row shows: a spell's whole path, or the value itself. */
	readonly label: string;
	readonly kind: PaletteCandidateKind;
	/** The spell's one line. Present on every spell row and on nothing else. */
	readonly describe?: string;
}

/**
 * The token the caret is on: the last one, or a fresh empty one when the line ends on a separator.
 * The same rule `read` applies, spelled again here because a caller needs the token's span to
 * rewrite the line and `read` only returns it inside a slot it may not produce.
 */
const caretToken = (input: string): {readonly token: Token; readonly depth: number} => {
	const {tokens, trailingSeparator} = tokenize(input);
	const depth = trailingSeparator ? tokens.length : Math.max(0, tokens.length - 1);
	return {
		token: tokens[depth] ?? {text: "", start: input.length, end: input.length},
		depth,
	};
};

/** Every spell at or beneath a node, in registry order. */
const spellsUnder = (node: IndexNode): ReadonlyArray<IndexedSpell> => {
	const found: Array<IndexedSpell> = [];
	if (node.spell !== undefined) found.push(node.spell);
	for (const child of node.children.values()) found.push(...spellsUnder(child));
	return found;
};

/**
 * One row per value, first occurrence winning. A workspace offers both its name and its id, and a
 * workspace named for its own id therefore reaches the list twice — the same row shown twice, which
 * is a row a founder can pick and learn nothing from.
 */
const dedupe = (rows: ReadonlyArray<PaletteCandidate>): ReadonlyArray<PaletteCandidate> => {
	const seen = new Set<string>();
	return rows.filter((row) => {
		const key = `${row.kind}:${row.value}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

/** The one case rule every match here applies, the same fold `complete` applies to its own. */
const fold = (text: string): string => text.toLowerCase();

/**
 * How a spell reached the list, low first. The order is the ruling: what the reader typed beats what
 * they half-remembered of the path, which beats a word the palette only found in the sentence.
 */
const PREFIX = 0;
const PATH = 1;
const SENTENCE = 2;

/** The tier a spell is listed at, or `undefined` for a spell the typed text does not reach at all. */
const rankOf = (
	needle: string,
	prefixed: boolean,
	remainingPath: string,
	describe: string,
): number | undefined => {
	if (prefixed) return PREFIX;
	if (fold(remainingPath).includes(needle)) return PATH;
	if (fold(describe).includes(needle)) return SENTENCE;
	return undefined;
};

export const paletteCandidates = (
	input: string,
	registry: SpellIndex,
	snapshot: Snapshot,
): ReadonlyArray<PaletteCandidate> => {
	const {slot} = read(input, registry);
	if (slot.kind !== "segment") {
		return dedupe(
			candidatesFor(slot, snapshot).map((candidate) => ({
				value: candidate.value,
				label: candidate.value,
				kind: candidate.kind,
				...(candidate.describe === undefined ? {} : {describe: candidate.describe}),
			})),
		);
	}

	// In a segment slot every token before the caret matched a segment, so the caret sits exactly
	// `depth` segments deep and a spell's remaining path is what accepting the row types.
	const {depth} = caretToken(input);
	const needle = fold(slot.token.text);
	const ranked: Array<{readonly rank: number; readonly row: PaletteCandidate}> = [];
	for (const [segment, child] of slot.node.children) {
		const prefixed = fold(segment).startsWith(needle);
		for (const spell of spellsUnder(child)) {
			// Accepting any row types the whole remaining path, so a spell found through its sentence
			// still leaves a line the parser reads as that spell's path.
			const value = spell.path.slice(depth).join(" ");
			const rank = rankOf(needle, prefixed, value, spell.describe);
			if (rank === undefined) continue;
			ranked.push({
				rank,
				row: {value, label: spell.path.join(" "), kind: "spell", describe: spell.describe},
			});
		}
	}
	// Registry order survives inside a tier: ECMA-262 requires the sort to be stable (§23.1.3.30).
	return ranked.sort((left, right) => left.rank - right.rank).map((entry) => entry.row);
};

/**
 * The line with the caret's token replaced by the candidate, and a separator after it so the next
 * segment or argument starts clean. Anything past the caret's token is whitespace by construction —
 * the caret's token is the last one — so rewriting from its start loses nothing.
 */
export const acceptCandidate = (input: string, candidate: PaletteCandidate): string =>
	`${input.slice(0, caretToken(input).token.start)}${candidate.value} `;
