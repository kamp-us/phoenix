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

/** How tightly `query` sits inside `value` as a subsequence: `undefined` when it does not. */
const subsequenceScore = (value: string, query: string): number | undefined => {
	if (query === "") return 0;
	const haystack = value.toLowerCase();
	const needle = query.toLowerCase();
	let first = -1;
	let cursor = 0;
	for (let index = 0; index < haystack.length && cursor < needle.length; index += 1) {
		if (haystack[index] !== needle[cursor]) continue;
		if (first < 0) first = index;
		cursor += 1;
		if (cursor === needle.length) {
			// Earlier beats later, and a tight run beats a scattered one; the span dominates so a
			// contiguous match late in a name still outranks a scattered one near its front.
			return (index - first) * 1000 + first;
		}
	}
	return undefined;
};

const byPrefix = (values: ReadonlyArray<Ranked>, query: string): ReadonlyArray<Candidate> =>
	values
		.filter((ranked) => ranked.candidate.value.startsWith(query))
		.map((ranked) => ranked.candidate);

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
