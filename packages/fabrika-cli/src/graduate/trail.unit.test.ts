import {describe, expect, it} from "vitest";
import type {Ticket} from "../map/frontier.ts";
import {
	type DecisionRow,
	digestOfDecisions,
	fromMap,
	fromSession,
	parseTrailDocument,
	readinessOf,
	trailOf,
} from "./trail.ts";

const DECISIONS: ReadonlyArray<DecisionRow> = [
	{ref: "R2.3", provenance: "ruled", text: "Weight is earned per account."},
	{ref: "R2.1", provenance: "established", text: "The vote table carries no weight column."},
];

describe("the digest", () => {
	it("is 12 lowercase hex over the three digested fields in trail order", () => {
		expect(digestOfDecisions(DECISIONS)).toMatch(/^[0-9a-f]{12}$/);
	});

	it("changes when a decision's provenance changes — a ruling is not a finding", () => {
		const flipped = DECISIONS.map((row) => ({...row, provenance: "established" as const}));
		expect(digestOfDecisions(flipped)).not.toBe(digestOfDecisions(DECISIONS));
	});

	it("changes when the entries are re-ordered — the digest covers trail order", () => {
		expect(digestOfDecisions([...DECISIONS].reverse())).not.toBe(digestOfDecisions(DECISIONS));
	});

	it("is neutral to trailing whitespace, so a round trip through GitHub cannot move it", () => {
		const padded = DECISIONS.map((row) => ({...row, text: `${row.text}   `}));
		expect(digestOfDecisions(padded)).toBe(digestOfDecisions(DECISIONS));
	});

	it("is taken over the entries alone — the spec digest of a subset differs from the trail's", () => {
		const subset = DECISIONS.slice(0, 1);
		expect(digestOfDecisions(subset)).not.toBe(digestOfDecisions(DECISIONS));
	});
});

describe("readiness", () => {
	it("is blocked whenever anything is unresolved, however much is decided", () => {
		expect(readinessOf(DECISIONS, [{ref: "R2.2", state: "open"}])).toBe("blocked");
	});

	it("is empty when nothing is unresolved and nothing is decided", () => {
		expect(readinessOf([], [])).toBe("empty");
	});

	it("is ready only with decisions and no open question", () => {
		expect(readinessOf(DECISIONS, [])).toBe("ready");
	});
});

describe("a session's questions, normalized", () => {
	const normalized = fromSession([
		{id: "R1.1", text: "does the column exist?", state: "answered"},
		{id: "R1.2", text: "is weight inherited?", state: "ruled"},
		{id: "R1.3", text: "what about decay?", state: "open"},
		{id: "R1.4", text: "unattested one", state: "unattested"},
		{id: "R1.5", text: "retired one", state: "superseded"},
	]);

	it("maps ruled to `ruled` and answered to `established`, in trail order", () => {
		expect(normalized.decisions).toEqual([
			{ref: "R1.1", provenance: "established", text: "does the column exist?"},
			{ref: "R1.2", provenance: "ruled", text: "is weight inherited?"},
		]);
	});

	it("carries the resolver's own state word on every unresolved row", () => {
		expect(normalized.unresolved).toEqual([
			{ref: "R1.3", state: "open"},
			{ref: "R1.4", state: "unattested"},
		]);
	});

	it("omits a superseded question entirely — it is neither a decision nor an open one", () => {
		const refs = [...normalized.decisions, ...normalized.unresolved].map((row) => row.ref);
		expect(refs).not.toContain("R1.5");
	});
});

describe("a map's body and tickets, normalized", () => {
	const ticket = (number: number, state: Ticket["state"]): Ticket => ({
		number,
		kind: "research",
		question: `question ${number}`,
		state,
		blockedBy: [],
		blocking: [],
	});

	const normalized = fromMap(
		[
			{
				text: "Weight is earned per account.",
				authority: {_tag: "Ruled", session: 9301, questionId: "R1.2"},
			},
			{text: "The vote table has no weight column.", authority: {_tag: "Finding", ticket: 9505}},
		],
		[ticket(9142, "open"), ticket(9505, "graduated"), ticket(9506, "retired")],
	);

	it("takes decisions from the `## Decisions` section, not from ticket states", () => {
		expect(normalized.decisions).toEqual([
			{ref: "#9301 R1.2", provenance: "ruled", text: "Weight is earned per account."},
			{ref: "#9505", provenance: "established", text: "The vote table has no weight column."},
		]);
	});

	it("leaves a graduated and a retired ticket off the unresolved list, and keeps the open one", () => {
		expect(normalized.unresolved).toEqual([{ref: "#9142", state: "open"}]);
	});
});

describe("trailOf", () => {
	it("counts by provenance and seats the digest over every decision", () => {
		const trail = trailOf({
			source: 9412,
			kind: "grilling",
			decisions: DECISIONS,
			unresolved: [],
			outOfScope: [],
		});
		expect(trail.counts).toEqual({ruled: 1, established: 1, unresolved: 0});
		expect(trail.trailDigest).toBe(digestOfDecisions(DECISIONS));
		expect(trail.readiness).toBe("ready");
	});
});

describe("reading a --trail document back", () => {
	const document = JSON.stringify(
		trailOf({source: 9412, kind: "grilling", decisions: DECISIONS, unresolved: [], outOfScope: []}),
	);

	it("round-trips what `graduate trail` printed", () => {
		const read = parseTrailDocument(document);
		expect(read._tag).toBe("Trail");
		if (read._tag !== "Trail") return;
		expect(read.value.decisions).toEqual(DECISIONS);
		expect(read.value.trailDigest).toBe(digestOfDecisions(DECISIONS));
	});

	it("reports bytes that are not a trail as unreadable, never as an empty trail", () => {
		expect(parseTrailDocument("not json at all")._tag).toBe("Unreadable");
		expect(parseTrailDocument("{}")._tag).toBe("Unreadable");
	});

	it("reports a decision missing a digested field as unbindable, naming the field", () => {
		const read = parseTrailDocument(
			JSON.stringify({
				trailDigest: "a1b2c3d4e5f6",
				decisions: [{ref: "R1.1", provenance: "ruled"}],
			}),
		);
		expect(read).toMatchObject({_tag: "Unbindable", reason: "text"});
	});

	it("reports a digest that is not 12 hex as unbindable", () => {
		const read = parseTrailDocument(
			JSON.stringify({trailDigest: "NOTHEX", decisions: [...DECISIONS]}),
		);
		expect(read).toMatchObject({_tag: "Unbindable", reason: "trailDigest"});
	});
});
