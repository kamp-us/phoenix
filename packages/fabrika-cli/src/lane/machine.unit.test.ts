import {describe, expect, it} from "vitest";
import {
	choreWorkflow,
	coderWorkflow,
	stateNode,
	twoPhaseWorkflow,
} from "./fixtures.test-support.ts";
import {applyEvent, foldLog, type LogEntry} from "./fold.ts";
import {type CompiledLane, compile, OPERATOR_EVENTS, topology} from "./machine.ts";

const compiled = (workflow: unknown) => {
	const result = compile(workflow);
	if (result._tag !== "Compiled") throw new Error(`malformed: ${result.defects.join("; ")}`);
	return result.lane;
};

const defined = <T>(value: T | undefined): T => {
	if (value === undefined) throw new Error("expected the compiled task to be present");
	return value;
};

/** Drive one task's events through `applyEvent`, returning the leaf state each one folded to. */
const leaves = (
	lane: CompiledLane,
	task: string,
	events: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const log: LogEntry[] = [];
	const statesOf = () => {
		const fold = foldLog(lane, log);
		if (fold._tag !== "Folded") throw new Error(fold.defects.join("; "));
		return fold.states;
	};
	return events.map((event) => {
		const applied = applyEvent(lane, statesOf(), task, event, "2026-08-17T00:00:00.000Z");
		if (applied._tag !== "Applied") throw new Error(`${task} ${event}: ${applied.reason}`);
		log.push(applied.entry);
		return defined(statesOf()[task]).type;
	});
};

const defectsOf = (workflow: unknown): string => {
	const result = compile(workflow);
	expect(result._tag).toBe("Malformed");
	return result._tag === "Malformed" ? result.defects.join("\n") : "";
};

/** Reach a fixture's machine-level `states` map, for a test to mutate one phase or terminal. */
const machineStates = (
	workflow: Record<string, unknown>,
): Record<string, Record<string, unknown>> =>
	(workflow.machine as Record<string, unknown>).states as Record<string, Record<string, unknown>>;

describe("the compiler — structural recognition", () => {
	it("compiles the committed coder template", () => {
		const lane = compiled(coderWorkflow());

		expect(lane.phases).toEqual([{name: "pipeline", tasks: ["issue"]}]);
		expect(lane.terminals).toEqual({complete: "complete", tripped: "tripped"});
		expect(defined(lane.tasks.issue).initial).toEqual({type: "queued", retries: 0, maxRetries: 2});
		expect([...defined(lane.tasks.issue).finals].sort()).toEqual(["frozen", "shipped"]);
		expect([...defined(lane.tasks.issue).errorFinals]).toEqual(["frozen"]);
	});

	it("reads a guarded array as retry-or-fallthrough by shape, never by guard name", () => {
		const noNames = twoPhaseWorkflow();
		// Strip every guard/action name — the arms are bare targets and must compile identically.
		stateNode(noNames, "task_a", "checking").on["TASK_A.FAIL"] = [
			{target: "doing"},
			{target: "tripped"},
		];

		const lane = compiled(noNames);
		expect([...defined(lane.tasks.task_a).errorFinals]).toEqual(["tripped"]);
	});

	it("carries the per-task context through: maxRetries into state, the rest into extras", () => {
		const lane = compiled(twoPhaseWorkflow());

		expect(defined(lane.tasks.task_a).initial.maxRetries).toBe(2);
		expect(defined(lane.tasks.task_a).extras).toEqual({code: true});
		expect(defined(lane.tasks.task_b).initial.maxRetries).toBe(3);
	});

	it("summarizes each state's legal events in the topology", () => {
		const summary = topology(compiled(coderWorkflow()));

		expect(defined(summary.tasks.issue).states.queued).toEqual(["WIP", "BLOCKED"]);
		expect(defined(summary.tasks.issue).states.review).toEqual(["PASS", "BLOCKED", "FAIL"]);
		expect(defined(summary.tasks.issue).states.ship).toEqual(["DONE", "BLOCKED", "FAIL"]);
		expect(defined(summary.tasks.issue).states.shipped).toEqual([]);
		expect(summary.trigger).toBeUndefined();
	});

	it("re-enters build on a FAIL at ship, and freezes once the retries are spent (#5807)", () => {
		const lane = compiled(coderWorkflow());
		const toShip = ["WIP", "DONE", "PASS"];
		const roundTrip = ["FAIL", "DONE", "PASS"];

		expect(leaves(lane, "issue", [...toShip, ...roundTrip, ...roundTrip, "FAIL"])).toEqual([
			"build",
			"review",
			"ship",
			"build",
			"review",
			"ship",
			"build",
			"review",
			"ship",
			"frozen",
		]);
	});

	it("compiles the committed chore template, carrying its declared trigger", () => {
		const lane = compiled(choreWorkflow());

		expect(lane.phases).toEqual([{name: "sweep", tasks: ["park_sweep"]}]);
		expect(lane.trigger).toBe("lane-parked");
		expect(topology(lane).trigger).toBe("lane-parked");
		expect(defined(lane.tasks.park_sweep).initial).toEqual({
			type: "queued",
			retries: 0,
			maxRetries: 2,
		});
		expect([...defined(lane.tasks.park_sweep).errorFinals]).toEqual(["frozen"]);
	});

	it("holds the chore template to the same six events as every other lane", () => {
		const summary = topology(compiled(choreWorkflow()));
		const listened = new Set(Object.values(defined(summary.tasks.park_sweep).states).flat());

		for (const event of listened) expect(OPERATOR_EVENTS).toContain(event);
	});
});

describe("the compiler — refusals", () => {
	it("refuses an event outside the operator's six, naming them", () => {
		const workflow = twoPhaseWorkflow();
		stateNode(workflow, "task_a", "doing").on["TASK_A.MERGE"] = "checking";

		expect(defectsOf(workflow)).toContain(OPERATOR_EVENTS.join("/"));
	});

	it("refuses a transition to a state the region does not have", () => {
		const workflow = twoPhaseWorkflow();
		stateNode(workflow, "task_a", "doing").on["TASK_A.DONE"] = "nowhere";

		expect(defectsOf(workflow)).toContain('unknown state "nowhere"');
	});

	it("refuses a guarded array that is not the two-arm shape", () => {
		const workflow = twoPhaseWorkflow();
		stateNode(workflow, "task_a", "checking").on["TASK_A.FAIL"] = [{target: "doing"}];

		expect(defectsOf(workflow)).toContain("two-arm array");
	});

	it("refuses a machine with no parallel phase, and one with no readable onDone pair", () => {
		expect(defectsOf({machine: {states: {alone: {type: "final"}}}})).toContain("parallel");

		const noGate = twoPhaseWorkflow();
		const phase1 = ((noGate.machine as Record<string, unknown>).states as Record<string, unknown>)
			.phase1 as Record<string, unknown>;
		phase1.onDone = undefined;
		expect(defectsOf(noGate)).toContain("onDone");
	});

	it("refuses a machine-level state that lost its `parallel` type, never dropping it", () => {
		const workflow = twoPhaseWorkflow();
		delete defined(machineStates(workflow).phase2).type;

		expect(defectsOf(workflow)).toContain(
			'machine-level state "phase2" is neither a `parallel` phase nor a `final` terminal',
		);
	});

	it("refuses an `onDone` target that names no machine-level state", () => {
		const workflow = twoPhaseWorkflow();
		defined(machineStates(workflow).phase2).onDone = [
			{target: "compleet", guard: "noErrors"},
			{target: "tripped"},
		];

		expect(defectsOf(workflow)).toContain('unknown machine-level state "compleet"');
	});

	it("refuses a machine-level final no `onDone` pair reaches", () => {
		const workflow = twoPhaseWorkflow();
		machineStates(workflow).orphan = {type: "final"};

		expect(defectsOf(workflow)).toContain(
			'machine-level final "orphan" is targeted by no phase\'s `onDone` pair',
		);
	});

	it("refuses a `trigger` that is not a string, rather than ignoring the declaration", () => {
		const workflow = {...twoPhaseWorkflow(), trigger: {on: "lane-parked"}};

		expect(defectsOf(workflow)).toContain("`trigger` must be a string");
	});

	it("refuses a document that is not machine-shaped at all", () => {
		expect(defectsOf(null)).toContain("machine.states");
		expect(defectsOf({})).toContain("machine.states");
	});
});
