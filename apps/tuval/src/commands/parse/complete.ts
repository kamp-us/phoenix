/**
 * The ranked candidate list for the token under the caret. Two rules, and they never mix:
 *
 * 1. **Exact prefix, for names the system defines** — spell path segments, program ids, and an enum
 *    parameter's literals. A name is offered only when the caret's text is a prefix of it, in the
 *    order the registry or the snapshot lists it. `win` never reaches `wizard-inspect`: a system
 *    name is something to recall, not something to search.
 * 2. **Fuzzy subsequence, for values a user named** — the window ids, process ids, workspace ids and
 *    workspace names the snapshot carries. The caret's characters must appear in order; the tighter
 *    and earlier the run, the higher the rank. `scr` reaches `scratch`.
 *
 * Both rules ignore case, through the one `fold` below (#7757). `W` offers exactly what `w` offers,
 * at a segment and at a window alike: the recall-don't-search argument behind rule 1 is about the
 * matching rule, not about capitalization, and a capitalized id offering nothing reads as broken.
 *
 * The fuzzy rank is over the *tightest* run in the value, not the first one found. `a-xb-ab` matches
 * `ab` at 0-3 and again at 5-6, and the run it is ranked by is 5-6.
 *
 * A fuzzy tie breaks on recency, most recent first (#7617 R1.5): every window and process row on the
 * snapshot carries the kernel's `recency` stamp, so two equally tight matches are ordered by which
 * one was focused or spawned last. Values with no stamp of their own — a workspace name, a
 * workspace id — tie on collection order instead, and that is `Array.prototype.sort` doing it:
 * ECMA-262 requires the sort to be stable (§23.1.3.30), so two calls over one snapshot return one
 * list.
 *
 * Which live set a parameter draws from is its own name: a parameter named for a window, a process,
 * a program or a workspace offers that set, and one named for none of them offers no live values —
 * the parser has no way to know what an arbitrary string parameter accepts.
 */

import type {Snapshot} from "../../protocol/messages.ts";
import type {Slot} from "./reading.ts";
import {read} from "./reading.ts";
import type {ParamSpec, SpellIndex} from "./spell-index.ts";

export type CandidateKind = "segment" | "program" | "literal" | "window" | "process" | "workspace";

export interface Candidate {
	/** The text that replaces the caret's token. */
	readonly value: string;
	readonly kind: CandidateKind;
	/** The spell's one line, on a segment that completes a whole spell. */
	readonly describe?: string;
}

/**
 * The live set a parameter draws from, in snapshot order, with the rule that ranks it. Program ids
 * are a system name and rank by prefix; the rest are user-named and rank fuzzily.
 */
interface LiveSet {
	readonly values: ReadonlyArray<Ranked>;
	readonly ranking: "prefix" | "fuzzy";
}

/** A candidate with the stamp its tie breaks on. Zero is "no stamp", which is every system name. */
interface Ranked {
	readonly candidate: Candidate;
	readonly recency: number;
}

const unstamped = (candidate: Candidate): Ranked => ({candidate, recency: 0});

const EMPTY: LiveSet = {values: [], ranking: "prefix"};

const liveValues = (param: ParamSpec, snapshot: Snapshot): LiveSet => {
	const name = param.name.toLowerCase();
	if (name.includes("program")) {
		const ids = [...new Set(snapshot.processes.map((row) => row.programId as string))];
		return {
			values: ids.map((id) => unstamped({value: id, kind: "program"})),
			ranking: "prefix",
		};
	}
	if (name.includes("window")) {
		const values = Object.values(snapshot.windows).map(
			(window): Ranked => ({
				candidate: {value: window.id, kind: "window"},
				recency: window.recency,
			}),
		);
		return {values, ranking: "fuzzy"};
	}
	if (name.includes("process")) {
		const values = snapshot.processes.map(
			(row): Ranked => ({candidate: {value: row.id, kind: "process"}, recency: row.recency}),
		);
		return {values, ranking: "fuzzy"};
	}
	if (name.includes("workspace")) {
		const values = Object.values(snapshot.desk.workspaces).flatMap(
			(workspace): Array<Ranked> => [
				unstamped({value: workspace.name, kind: "workspace"}),
				unstamped({value: workspace.id, kind: "workspace"}),
			],
		);
		return {values, ranking: "fuzzy"};
	}
	return EMPTY;
};

/** The one case rule both matchers apply. */
const fold = (text: string): string => text.toLowerCase();

/**
 * How tightly `query` sits inside `value` as a subsequence: `undefined` when it does not.
 *
 * Exported for the ranking tests, which pin the score of a named value against the run they name.
 */
export const subsequenceScore = (value: string, query: string): number | undefined => {
	if (query === "") return 0;
	const haystack = fold(value);
	const needle = fold(query);
	let best: number | undefined;
	for (let start = 0; start < haystack.length; start += 1) {
		if (haystack[start] !== needle[0]) continue;
		let cursor = 1;
		let index = start + 1;
		for (; index < haystack.length && cursor < needle.length; index += 1) {
			if (haystack[index] === needle[cursor]) cursor += 1;
		}
		// A start that cannot complete leaves every later start less room, so none can either.
		if (cursor < needle.length) break;
		// Earlier beats later, and a tight run beats a scattered one; the span dominates so a
		// contiguous match late in a name still outranks a scattered one near its front.
		const score = (index - 1 - start) * 1000 + start;
		if (best === undefined || score < best) best = score;
	}
	return best;
};

const byPrefix = (values: ReadonlyArray<Ranked>, query: string): ReadonlyArray<Candidate> => {
	const needle = fold(query);
	return values
		.filter((ranked) => fold(ranked.candidate.value).startsWith(needle))
		.map((ranked) => ranked.candidate);
};

const byFuzz = (values: ReadonlyArray<Ranked>, query: string): ReadonlyArray<Candidate> =>
	values
		.flatMap((ranked) => {
			const score = subsequenceScore(ranked.candidate.value, query);
			return score === undefined ? [] : [{ranked, score}];
		})
		.sort((left, right) => left.score - right.score || right.ranked.recency - left.ranked.recency)
		.map((scored) => scored.ranked.candidate);

export const candidatesFor = (slot: Slot, snapshot: Snapshot): ReadonlyArray<Candidate> => {
	if (slot.kind === "none") return [];
	if (slot.kind === "segment") {
		const segments: Array<Ranked> = [];
		for (const [segment, child] of slot.node.children) {
			segments.push(
				unstamped(
					child.spell === undefined
						? {value: segment, kind: "segment"}
						: {value: segment, kind: "segment", describe: child.spell.describe},
				),
			);
		}
		return byPrefix(segments, slot.token.text);
	}
	if (slot.param.literals !== undefined) {
		return byPrefix(
			slot.param.literals.map((literal) => unstamped({value: literal, kind: "literal"})),
			slot.token.text,
		);
	}
	const live = liveValues(slot.param, snapshot);
	return live.ranking === "prefix"
		? byPrefix(live.values, slot.token.text)
		: byFuzz(live.values, slot.token.text);
};

export const complete = (
	input: string,
	registry: SpellIndex,
	snapshot: Snapshot,
): ReadonlyArray<Candidate> => candidatesFor(read(input, registry).slot, snapshot);
