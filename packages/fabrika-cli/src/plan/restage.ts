/**
 * The pure half of `plan restage` — an epic body and its observed child links in, the same body with
 * its `## Dependencies` region reconciled out.
 *
 * **What "reconciled" means is one rule: a ref the board proves closed without landing is dropped.**
 * `lane emit` boots a child's region from that child's close reason — `completed` boots `landed`, and
 * every other close boots `frozen`, a final carrying a door, which trips the phase the instant the
 * machine starts. So an epic whose plan still names a child somebody closed as a duplicate can only
 * emit a machine that trips, and until this verb existed the sole repair was a human editing the
 * epic body by hand. A `completed` close is **kept**: its region boots `landed`, the phase folds, and
 * dropping it would erase the sequencing the children after it were planned behind.
 *
 * **A ref the observation set does not name is left exactly as it is.** The observations are the
 * epic's native sub-issue links, which is the same set `lane emit` checks every ref against, so the
 * two can never disagree about one edge. A `requires:` pointing at another epic's issue, or a
 * ledger-local `C<int>`, is not observed here and is not judged here — `lane emit`'s own `Foreign`
 * arm is what reports it, and a reconcile that guessed at an unobserved ref would be rewriting a
 * plan on no evidence.
 *
 * **Nothing outside the region is touched, and an unchanged topology composes no body at all.** The
 * span comes from `build/dependencies.ts`, the one module that states where the section ends, so
 * this writer and every reader cut at the same byte.
 */

import {
	type Edge,
	type Ref,
	readTopology,
	renderTopologyBlock,
	topologySpans,
} from "../build/dependencies.ts";
import {preservedEnvelope} from "../triage/enrich.ts";

/** One child link as the board reports it — `plan/github.ts`'s `SubIssueLink`, narrowed to what is judged. */
export interface Observed {
	readonly number: number;
	readonly state: "open" | "closed";
	readonly stateReason: string | null;
}

export type Restage =
	| {
			readonly _tag: "Restaged";
			readonly body: string;
			/** The issues the reconcile removed, ascending. */
			readonly dropped: ReadonlyArray<number>;
			/** The issues the reconciled region still names, ascending. */
			readonly kept: ReadonlyArray<number>;
	  }
	/** Every ref the region names is still live — the idempotent no-op, and nothing is written. */
	| {readonly _tag: "Unchanged"; readonly kept: ReadonlyArray<number>}
	/** Dropping the abandoned refs would leave no phase at all — a plan to re-plan, not to rewrite. */
	| {readonly _tag: "Emptied"; readonly dropped: ReadonlyArray<number>}
	/** The body carries no `## Dependencies` heading. */
	| {readonly _tag: "Absent"}
	/** It carries more than one, so the region has no single meaning. */
	| {readonly _tag: "Ambiguous"; readonly count: number}
	/** The only one sits inside the preserved brief — that is filed content, not a machine-owned region. */
	| {readonly _tag: "InPreservedBrief"}
	| {readonly _tag: "Unparseable"; readonly line: number; readonly text: string}
	/** The composed region does not parse back to the edges it was composed from. */
	| {readonly _tag: "ReadbackMismatch"};

/** Closed for a reason other than `completed` — closed without landing, in `lane emit`'s own terms. */
const abandonedIn = (observations: ReadonlyArray<Observed>): ReadonlySet<number> =>
	new Set(
		observations
			.filter((link) => link.state === "closed" && link.stateReason !== "completed")
			.map((link) => link.number),
	);

const refsOf = (edge: Edge): ReadonlyArray<Ref> =>
	edge._tag === "Phase" ? edge.members : [edge.subject, ...edge.needs];

const issueNumbers = (edges: ReadonlyArray<Edge>): ReadonlyArray<number> =>
	[
		...new Set(
			edges.flatMap((edge) =>
				refsOf(edge).flatMap((ref) => (ref._tag === "Issue" ? [ref.number] : [])),
			),
		),
	].sort((a, b) => a - b);

/**
 * The edge list with every abandoned ref removed.
 *
 * A phase line that loses every member disappears, and so does a `requires:` line whose subject was
 * dropped or whose needs all were — a line naming nothing is not an edge, and leaving an empty one
 * behind would not parse back.
 */
const filterEdges = (
	edges: ReadonlyArray<Edge>,
	abandoned: ReadonlySet<number>,
): ReadonlyArray<Edge> => {
	const alive = (ref: Ref): boolean => !(ref._tag === "Issue" && abandoned.has(ref.number));
	const kept: Edge[] = [];
	for (const edge of edges) {
		if (edge._tag === "Phase") {
			const members = edge.members.filter(alive);
			if (members.length > 0) kept.push({...edge, members});
			continue;
		}
		if (!alive(edge.subject)) continue;
		const needs = edge.needs.filter(alive);
		if (needs.length > 0) kept.push({...edge, needs});
	}
	return kept;
};

/**
 * Reconcile the body's `## Dependencies` region against the observations.
 *
 * `body` is normalized to LF first, so the composed body a caller compares its read-back against is
 * the one this function produced rather than one line-ending convention read as another.
 */
export const restageBody = (body: string, observations: ReadonlyArray<Observed>): Restage => {
	const normalized = body.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const spans = topologySpans(normalized);
	const span = spans[0];
	if (span === undefined) return {_tag: "Absent"};
	if (spans.length > 1) return {_tag: "Ambiguous", count: spans.length};

	const envelope = preservedEnvelope(lines);
	if (envelope !== null && span.heading > envelope.start && span.heading < envelope.end) {
		return {_tag: "InPreservedBrief"};
	}

	const topology = readTopology(normalized);
	if (topology._tag === "Absent") return {_tag: "Absent"};
	if (topology._tag === "Unparseable") {
		return {_tag: "Unparseable", line: topology.line, text: topology.text};
	}

	const abandoned = abandonedIn(observations);
	const named = issueNumbers(topology.edges);
	const dropped = named.filter((number) => abandoned.has(number));
	if (dropped.length === 0) return {_tag: "Unchanged", kept: named};

	const filtered = filterEdges(topology.edges, abandoned);
	if (!filtered.some((edge) => edge._tag === "Phase")) return {_tag: "Emptied", dropped};

	const block = renderTopologyBlock(filtered);
	const reparsed = readTopology(block);
	if (reparsed._tag !== "Parsed" || renderTopologyBlock(reparsed.edges) !== block) {
		return {_tag: "ReadbackMismatch"};
	}

	const before = lines.slice(0, span.heading).join("\n").replace(/\s+$/, "");
	const after = lines.slice(span.end).join("\n").replace(/^\n+/, "");
	const head = before === "" ? "" : `${before}\n\n`;
	const tail = after.trim() === "" ? "" : `\n${after}`;
	return {
		_tag: "Restaged",
		body: `${head}${block}${tail}`,
		dropped,
		kept: issueNumbers(filtered),
	};
};
