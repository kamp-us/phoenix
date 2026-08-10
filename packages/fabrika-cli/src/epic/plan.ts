/**
 * The epic body's planned ledger: which slices a run conducts, and in what order.
 *
 * The body carries a `## Slices` section of `- <id>: <title> — #<issue>` lines and the
 * `## Dependencies` block whose grammar `build`'s `dependencies.ts` owns. This module adds **no
 * second dependency grammar** — it imports that parser and orders the slice ids by it.
 *
 * **Unparseable refuses; it is never read as "no slices."** A conductor that derived an empty plan
 * from prose would dispatch nothing and report a finished run (ADR 0092, #4104).
 */
import {predecessorsOf, type Ref, readTopology, sameRef} from "../build/dependencies.ts";

export interface PlannedSlice {
	/** The ledger-local id, `C<int>` — the same vocabulary the `## Dependencies` refs speak. */
	readonly id: string;
	readonly issue: number;
	/** The title as the plan writes it; `epic open` answers with the child issue's own. */
	readonly title: string;
}

export type PlanRead =
	| {readonly _tag: "Plan"; readonly slices: ReadonlyArray<PlannedSlice>}
	/** No `## Slices` heading, or nothing under it parses — one refusal, because both are `4`. */
	| {readonly _tag: "Unparseable"; readonly reason: string};

const HEADING_RE = /^##\s+Slices\s*$/;
const ANY_HEADING_RE = /^#{1,6}\s+/;
/** `- C1: extract the totals module — #311`. The title is greedy so a hyphenated title still parses. */
const SLICE_RE = /^-\s*(C\d+)\s*:\s*(.*\S)\s*(?:—|–|--|-)\s*#(\d+)\s*$/;

/** Read the `## Slices` section. Every non-blank line in it must be a slice line. */
export const readPlan = (body: string): PlanRead => {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => HEADING_RE.test(line.trim()));
	if (start === -1) return {_tag: "Unparseable", reason: 'the body carries no "## Slices" heading'};

	const slices: PlannedSlice[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const text = (lines[i] ?? "").trim();
		if (text === "") continue;
		if (ANY_HEADING_RE.test(text)) break;
		const match = SLICE_RE.exec(text);
		if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
			return {
				_tag: "Unparseable",
				reason: `line ${i + 1} is not a "- C<n>: <title> — #<issue>" slice line: "${text}"`,
			};
		}
		if (slices.some((slice) => slice.id === match[1])) {
			return {_tag: "Unparseable", reason: `slice id "${match[1]}" is declared twice`};
		}
		slices.push({id: match[1], title: match[2], issue: Number.parseInt(match[3], 10)});
	}
	const [first] = slices;
	return first === undefined
		? {_tag: "Unparseable", reason: '"## Slices" is present and holds no slice line'}
		: {_tag: "Plan", slices};
};

export type OrderRead =
	| {readonly _tag: "Order"; readonly order: ReadonlyArray<string>}
	| {readonly _tag: "Unparseable"; readonly reason: string};

/** Both spellings of one slice: the plan's local id, and the child issue the plan names. */
const refsOf = (slice: PlannedSlice): ReadonlyArray<Ref> => [
	{_tag: "Local", id: slice.id},
	{_tag: "Issue", number: slice.issue},
];

/**
 * The topological order of the `## Dependencies` parse, ties broken by ascending issue ref.
 *
 * Deterministic by construction: two runs over one epic derive one order, which is what a stall
 * detector over the run needs (`epic-ledger`'s ordering contract, read as prior art).
 */
export const readOrder = (body: string, slices: ReadonlyArray<PlannedSlice>): OrderRead => {
	const topology = readTopology(body);
	if (topology._tag === "Absent") {
		return {_tag: "Unparseable", reason: 'the body carries no "## Dependencies" block'};
	}
	if (topology._tag === "Unparseable") {
		return {
			_tag: "Unparseable",
			reason: `"## Dependencies" line ${topology.line} does not parse: "${topology.text}"`,
		};
	}

	const pending = [...slices].sort((a, b) => a.issue - b.issue);
	const done = new Set<string>();
	const order: string[] = [];
	while (pending.length > 0) {
		const index = pending.findIndex((slice) =>
			refsOf(slice)
				.flatMap((ref) => predecessorsOf(topology.edges, ref))
				.every(({ref}) => {
					const named = slices.find((other) => refsOf(other).some((own) => sameRef(own, ref)));
					return named === undefined || done.has(named.id);
				}),
		);
		if (index === -1) {
			return {
				_tag: "Unparseable",
				reason: `"## Dependencies" has a cycle over ${pending.map((s) => s.id).join(", ")}`,
			};
		}
		const [taken] = pending.splice(index, 1);
		if (taken === undefined) break;
		done.add(taken.id);
		order.push(taken.id);
	}
	return {_tag: "Order", order};
};
