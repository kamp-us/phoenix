import {describe, expect, it} from "vitest";
import {
	BASE,
	LANDED,
	ledgerOf,
	PLAN_RECORD,
	RUN,
	verdictMarkerFor,
} from "./fixtures.test-support.ts";
import {foldRun, type GraphFacts, nextAction} from "./fold.ts";
import {type LedgerLine, parseLedger} from "./ledger.ts";

const linesOf = (jsonl: string): ReadonlyArray<LedgerLine> => {
	const read = parseLedger(jsonl);
	return read._tag === "Ledger" ? read.lines : [];
};

const graph = (
	head: string,
	known: ReadonlyArray<string>,
	ancestors: ReadonlyArray<string> = known,
): GraphFacts => ({
	head,
	present: new Set(known),
	ancestors: new Set(ancestors),
});

const C2_COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const act = (jsonl: string, facts: GraphFacts) =>
	nextAction(PLAN_RECORD, linesOf(jsonl), facts, RUN);

describe("nextAction", () => {
	it("dispatches the first slice of a freshly opened run", () => {
		expect(act(ledgerOf({event: "run-opened"}), graph(BASE, [BASE]))).toEqual({
			action: "dispatch-slice",
			slice: "C1",
			run: RUN,
		});
	});

	it("verifies an open dispatch from the GRAPH before anything else, and evaluates what landed", () => {
		const jsonl = ledgerOf(
			{event: "run-opened"},
			{event: "slice-dispatched", slice: "C1", sha: BASE},
		);
		expect(act(jsonl, graph(LANDED, [BASE, LANDED]))).toEqual({
			action: "evaluate-slice",
			slice: "C1",
			commit: LANDED,
		});
	});

	it("re-dispatches when the graph proves the dispatch produced nothing — HEAD never moved", () => {
		const jsonl = ledgerOf(
			{event: "run-opened"},
			{event: "slice-dispatched", slice: "C1", sha: BASE},
		);
		expect(act(jsonl, graph(BASE, [BASE]))).toEqual({
			action: "dispatch-slice",
			slice: "C1",
			run: RUN,
		});
	});

	it("evaluates a recorded landing that carries no verdict yet", () => {
		const jsonl = ledgerOf(
			{event: "run-opened"},
			{event: "slice-dispatched", slice: "C1", sha: BASE},
			{event: "slice-landed", slice: "C1", sha: LANDED},
		);
		expect(act(jsonl, graph(LANDED, [BASE, LANDED]))).toEqual({
			action: "evaluate-slice",
			slice: "C1",
			commit: LANDED,
		});
	});

	it("retries a FAIL under cap, injecting the recorded verdict's first line as Fix-First", () => {
		const jsonl = ledgerOf(
			{event: "run-opened"},
			{event: "slice-dispatched", slice: "C1", sha: BASE},
			{event: "slice-landed", slice: "C1", sha: LANDED},
			{
				event: "verdict-recorded",
				slice: "C1",
				detail: verdictMarkerFor("C1", "FAIL", LANDED, "the parser drops the final row"),
			},
		);
		expect(act(jsonl, graph(LANDED, [BASE, LANDED]))).toEqual({
			action: "retry-slice",
			slice: "C1",
			attempt: 2,
			fixFirst: "the parser drops the final row",
		});
	});

	it("escalates on the fail axis at cap, naming the axis and its OWN count", () => {
		const fail = {
			event: "verdict-recorded" as const,
			slice: "C1",
			detail: verdictMarkerFor("C1", "FAIL", LANDED, "still wrong"),
		};
		const jsonl = ledgerOf(
			{event: "run-opened"},
			{event: "slice-dispatched", slice: "C1", sha: BASE},
			{event: "slice-landed", slice: "C1", sha: LANDED},
			fail,
			{event: "retry-injected", slice: "C1"},
			fail,
		);
		expect(act(jsonl, graph(LANDED, [BASE, LANDED]))).toEqual({
			action: "escalate-slice",
			slice: "C1",
			axis: "fail",
			attempts: 2,
		});
	});

	it("escalates on the dead axis at cap without touching the fail axis", () => {
		const dead = {event: "dispatch-dead" as const, slice: "C1"};
		const jsonl = ledgerOf({event: "run-opened"}, dead, dead);
		expect(act(jsonl, graph(BASE, [BASE]))).toEqual({
			action: "escalate-slice",
			slice: "C1",
			axis: "dead",
			attempts: 2,
		});
	});

	it("answers open-pr once every slice is landed and PASS-bound", () => {
		const jsonl = ledgerOf(
			{event: "run-opened"},
			{event: "slice-dispatched", slice: "C1", sha: BASE},
			{event: "slice-landed", slice: "C1", sha: LANDED},
			{
				event: "verdict-recorded",
				slice: "C1",
				detail: verdictMarkerFor("C1", "PASS", LANDED, "clean"),
			},
			{event: "slice-dispatched", slice: "C2", sha: LANDED},
			{event: "slice-landed", slice: "C2", sha: C2_COMMIT},
			{
				event: "verdict-recorded",
				slice: "C2",
				detail: verdictMarkerFor("C2", "PASS", C2_COMMIT, "clean"),
			},
		);
		const facts = graph(C2_COMMIT, [BASE, LANDED, C2_COMMIT]);
		expect(act(jsonl, facts)).toEqual({action: "open-pr", epic: 4300});
	});

	it("answers halted the moment run-halted is recorded — the arm outranks every derived one", () => {
		const jsonl = ledgerOf({event: "run-opened"}, {event: "run-halted", detail: "operator"});
		expect(act(jsonl, graph(BASE, [BASE]))).toEqual({
			action: "halted",
			reason: "run-halted recorded",
		});
	});
});

describe("foldRun", () => {
	const jsonl = ledgerOf(
		{event: "run-opened"},
		{event: "slice-dispatched", slice: "C1", sha: BASE},
		{event: "slice-landed", slice: "C1", sha: LANDED},
		{
			event: "verdict-recorded",
			slice: "C1",
			detail: verdictMarkerFor("C1", "PASS", LANDED, "clean"),
		},
	);

	it("reports a verdict whose commit is still in the graph as current", () => {
		const folded = foldRun(PLAN_RECORD, linesOf(jsonl), graph(LANDED, [BASE, LANDED]));
		expect(folded[0]).toMatchObject({id: "C1", state: "passed", verdict: "current"});
		expect(folded[1]).toMatchObject({id: "C2", state: "pending", verdict: "none", commit: null});
	});

	it("reports a verdict whose commit LEFT the graph as unbindable — never as current", () => {
		const folded = foldRun(PLAN_RECORD, linesOf(jsonl), graph("f".repeat(40), [BASE]));
		expect(folded[0]?.verdict).toBe("unbindable");
		expect(folded[0]?.state).not.toBe("passed");
	});

	it("reports a slice whose last event is a dead dispatch as dead-dispatch", () => {
		const dead = ledgerOf(
			{event: "run-opened"},
			{event: "slice-dispatched", slice: "C1", sha: BASE},
			{event: "dispatch-dead", slice: "C1"},
		);
		expect(foldRun(PLAN_RECORD, linesOf(dead), graph(BASE, [BASE]))[0]).toMatchObject({
			state: "dead-dispatch",
			openSha: null,
		});
	});
});
