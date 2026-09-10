import {describe, expect, it} from "vitest";
import {readGoldenFixture} from "../golden-fixture.ts";
import {classifyPark, isPark} from "../recipe/parks.ts";
import {MACHINERY_LAP_BUDGET, RETRY_BUDGET} from "../retry-budget.ts";
import {WAIT_BUDGET} from "../wait-budget.ts";
import {
	choreWorkflow,
	coderWorkflow,
	stateNode,
	twoPhaseWorkflow,
} from "./fixtures.test-support.ts";
import {applyEvent, foldLog, type LogEntry, standingCauses} from "./fold.ts";
import {
	CANCELLED_EVENT,
	CANCELLED_STATE,
	CLEARED_EVENT,
	type CompiledLane,
	compile,
	LANDED_EVENT,
	LANDED_STATE,
	type LaneMsg,
	MACHINERY_EVENT,
	OPERATOR_EVENTS,
	type TaskState,
	topology,
} from "./machine.ts";
import {causeForEvent, eventForToken, routeForCause} from "./report.ts";

const compiled = (workflow: unknown) => {
	const result = compile(workflow);
	if (result._tag !== "Compiled") throw new Error(`malformed: ${result.defects.join("; ")}`);
	return result.lane;
};

const defined = <T>(value: T | undefined): T => {
	if (value === undefined) throw new Error("expected the compiled task to be present");
	return value;
};

/**
 * One driven event: a bare name, or one carrying a payload its own line records — the waits it
 * grants, whether the merge it reports left the issue open, or whether the terminal it reports was
 * proven off a diagnosis comment.
 */
type Step =
	| string
	| {
			readonly event: string;
			readonly waitGrant?: number;
			readonly partial?: boolean;
			readonly diagnosis?: boolean;
	  };

/** Drive one task's events through `applyEvent`, answering with the leaf each one folded to. */
const drive = (
	lane: CompiledLane,
	task: string,
	events: ReadonlyArray<Step>,
	classes: ReadonlyArray<string> | null = null,
): {readonly leaves: ReadonlyArray<string>; readonly state: TaskState} => {
	const log: LogEntry[] = [];
	const statesOf = () => {
		const fold = foldLog(lane, log);
		if (fold._tag !== "Folded") throw new Error(fold.defects.join("; "));
		return fold.states;
	};
	const reached = events.map((step, index) => {
		const event = typeof step === "string" ? step : step.event;
		// Only the first event carries the classes, so these tests also prove they stand afterwards.
		const applied = applyEvent(
			lane,
			statesOf(),
			task,
			event,
			"2026-08-17T00:00:00.000Z",
			index === 0 ? classes : null,
			typeof step === "string" ? null : (step.waitGrant ?? null),
			typeof step === "string" ? false : (step.partial ?? false),
			typeof step === "string" ? null : (step.diagnosis ?? null),
		);
		if (applied._tag !== "Applied") throw new Error(`${task} ${event}: ${applied.reason}`);
		log.push(applied.entry);
		return defined(statesOf()[task]).type;
	});
	return {leaves: reached, state: defined(statesOf()[task])};
};

const leaves = (
	lane: CompiledLane,
	task: string,
	events: ReadonlyArray<Step>,
	classes: ReadonlyArray<string> | null = null,
): ReadonlyArray<string> => drive(lane, task, events, classes).leaves;

/** Drive the same events as {@link leaves}, but answer with the task's folded state and budgets. */
const budgets = (lane: CompiledLane, task: string, events: ReadonlyArray<string>): TaskState =>
	driven(lane, task, events).state;

/**
 * Drive one task's events and answer with both its folded state and the cause standing over it.
 *
 * The cause rides the final entry because it is a field `lane report` writes onto the parking event
 * rather than machine state — the fold derives it back from there.
 */
const driven = (
	lane: CompiledLane,
	task: string,
	events: ReadonlyArray<string>,
	cause: string | null = null,
): {readonly state: TaskState; readonly cause: string | undefined} => {
	const log: LogEntry[] = [];
	const statesOf = () => {
		const fold = foldLog(lane, log);
		if (fold._tag !== "Folded") throw new Error(fold.defects.join("; "));
		return fold.states;
	};
	for (const [index, event] of events.entries()) {
		const applied = applyEvent(lane, statesOf(), task, event, "2026-08-20T00:00:00.000Z");
		if (applied._tag !== "Applied") throw new Error(`${task} ${event}: ${applied.reason}`);
		const last = index === events.length - 1 && cause !== null;
		log.push(last ? {...applied.entry, cause} : applied.entry);
	}
	return {state: defined(statesOf()[task]), cause: standingCauses(log)[task]};
};

/**
 * Every compiled cell of one task, driven and rendered — `state event classes retries -> next
 * retries`. The topology alone lists which events a state answers; this also pins where each
 * answer *goes*, which is what a routing change has to move.
 */
const cellTable = (lane: CompiledLane, taskId: string): string => {
	const update = defined(lane.tasks[taskId]).machine.update as Record<
		string,
		Record<string, (state: TaskState, msg: LaneMsg) => readonly [TaskState, unknown]>
	>;
	const rows: string[] = [];
	for (const [state, cells] of Object.entries(update)) {
		for (const event of Object.keys(cells)) {
			for (const classes of [[] as ReadonlyArray<string>, ["ui"]]) {
				for (const retries of [0, RETRY_BUDGET]) {
					// One "spent" axis drives all three counters, so the spent rows pin the fallthrough of a
					// FAIL arm, a wait arm and a lap arm alike without tripling the table.
					const from: TaskState = {
						type: state,
						retries,
						maxRetries: RETRY_BUDGET,
						cleared: [],
						classes: [],
						waits: retries === 0 ? 0 : WAIT_BUDGET,
						maxWaits: WAIT_BUDGET,
						laps: retries === 0 ? 0 : MACHINERY_LAP_BUDGET,
						maxLaps: MACHINERY_LAP_BUDGET,
						was: "review",
					};
					const [next] = defined(cells[event])(from, {type: event, classes});
					const carried = classes.length === 0 ? "-" : classes.join(",");
					rows.push(
						`${state}\t${event}\t${carried}\t${retries}/${RETRY_BUDGET}\t-> ${next.type}\t${next.retries}/${RETRY_BUDGET}\t${next.laps}/${MACHINERY_LAP_BUDGET}`,
					);
				}
			}
		}
	}
	return `${rows.join("\n")}\n`;
};

const defectsOf = (workflow: unknown): string => {
	const result = compile(workflow);
	expect(result._tag).toBe("Malformed");
	return result._tag === "Malformed" ? result.defects.join("\n") : "";
};

/** Reach one task's `context` entry, for a test to seed or corrupt a declaration in it. */
const taskContext = (workflow: Record<string, unknown>, task: string): Record<string, unknown> =>
	(
		(workflow.machine as Record<string, unknown>).context as Record<string, Record<string, unknown>>
	)[task] as Record<string, unknown>;

/** Reach a fixture's machine-level `states` map, for a test to mutate one phase or terminal. */
const machineStates = (
	workflow: Record<string, unknown>,
): Record<string, Record<string, unknown>> =>
	(workflow.machine as Record<string, unknown>).states as Record<string, Record<string, unknown>>;

/** Reach one phase-1 task region's `states` map, for a test to add a state to it. */
const regionStates = (workflow: Record<string, unknown>, task: string): Record<string, unknown> => {
	type Loose = Record<string, {states: Record<string, {states: Record<string, unknown>}>}>;
	const phases = (workflow.machine as {states: Loose}).states;
	const region = phases.phase1?.states[task];
	if (region === undefined) throw new Error(`fixture holds no task ${task}`);
	return region.states;
};

describe("the compiler — structural recognition", () => {
	it("compiles the committed coder template", () => {
		const lane = compiled(coderWorkflow());

		expect(lane.phases).toEqual([{name: "pipeline", tasks: ["issue"]}]);
		expect(lane.terminals).toEqual({complete: "complete", tripped: "tripped"});
		expect(defined(lane.tasks.issue).initial).toEqual({
			type: "queued",
			retries: 0,
			maxRetries: RETRY_BUDGET,
			cleared: [],
			classes: [],
			waits: 0,
			maxWaits: WAIT_BUDGET,
			laps: 0,
			maxLaps: MACHINERY_LAP_BUDGET,
		});
		// `cancelled` is the compiler's own final on every task, so it sits beside the document's two
		// and in neither of the two derived sets: a cancellation did not trip, and it has no door out.
		expect([...defined(lane.tasks.issue).finals].sort()).toEqual([
			CANCELLED_STATE,
			LANDED_STATE,
			"diagnosed",
			"human:budget-spent",
			"shipped",
		]);
		// The investigation terminal, named off the `done:diagnosis` arm that targets it — which is
		// what `deriveStatus` reads to answer "diagnosed" instead of collapsing it into `complete`.
		expect([...defined(lane.tasks.issue).diagnosisFinals]).toEqual(["diagnosed"]);
		// The spent-budget leaf is a final that carries a door — in `errorFinals` so the phase folds
		// and the lane trips loud, and in `openFinals` so the door stays walkable. Renaming it out of
		// `frozen` changed which of those sets it is in not at all; what changed is that `isPark`
		// matches a `human:*` leaf, so a recipe can see the park it always was.
		expect([...defined(lane.tasks.issue).errorFinals]).toEqual(["human:budget-spent"]);
		expect([...defined(lane.tasks.issue).openFinals]).toEqual(["human:budget-spent"]);
		expect([...defined(lane.tasks.issue).guardedStates].sort()).toEqual([
			"review",
			"review:ui",
			"ship",
			"ship:queued",
		]);
	});

	it("counts a state as guarded only for the retry budget, never for the wait budget", () => {
		const workflow = twoPhaseWorkflow();
		// A WIP-guarded array spends `waits`, and its spent fallthrough is a park that names the stall
		// — not a fall back into the error final a resume just left, so it is no resume hazard.
		stateNode(workflow, "task_a", "doing").on["TASK_A.WIP"] = [
			{target: "doing"},
			{target: "tripped"},
		];

		const lane = compiled(workflow);

		expect([...defined(lane.tasks.task_a).guardedStates]).toEqual(["checking"]);
	});

	it("leaves every final an end but the spent-budget park, though all take the injected cells", () => {
		const summary = topology(compiled(coderWorkflow()));

		// Both injected cells are on `shipped` too, and neither must make it a park: an open final is
		// one the DOCUMENT left a door in, a clearance is a door out of nothing, and a cancellation
		// leads to a terminal rather than back into the lane.
		expect(defined(summary.tasks.issue).states.shipped).toEqual([
			CLEARED_EVENT,
			CANCELLED_EVENT,
			LANDED_EVENT,
		]);
		// The cancellation final holds neither cell of its own: a second cancellation would fold as
		// movement that did not happen.
		expect(defined(summary.tasks.issue).states[CANCELLED_STATE]).toEqual([CLEARED_EVENT]);
		expect(defined(summary.tasks.issue).states[LANDED_STATE]).toEqual([CLEARED_EVENT]);
		expect([...defined(compiled(coderWorkflow()).tasks.issue).openFinals]).toEqual([
			"human:budget-spent",
		]);
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

		// Every state also holds the compiler's own `CLEARED` cell, which no document declares.
		expect(defined(summary.tasks.issue).states.queued).toEqual([
			"WIP",
			"BLOCKED",
			CLEARED_EVENT,
			CANCELLED_EVENT,
			LANDED_EVENT,
		]);
		expect(defined(summary.tasks.issue).states.review).toEqual([
			"PASS",
			"BLOCKED",
			MACHINERY_EVENT,
			"FAIL",
			CLEARED_EVENT,
			CANCELLED_EVENT,
			LANDED_EVENT,
		]);
		expect(defined(summary.tasks.issue).states.ship).toEqual([
			MACHINERY_EVENT,
			"DONE",
			"WIP",
			"BLOCKED",
			"FAIL",
			CLEARED_EVENT,
			CANCELLED_EVENT,
			LANDED_EVENT,
		]);
		expect(defined(summary.tasks.issue).states["ship:queued"]).toEqual([
			MACHINERY_EVENT,
			"DONE",
			"BLOCKED",
			"WIP",
			"FAIL",
			CLEARED_EVENT,
			CANCELLED_EVENT,
			LANDED_EVENT,
		]);
		expect(defined(summary.tasks.issue).states.shipped).toEqual([
			CLEARED_EVENT,
			CANCELLED_EVENT,
			LANDED_EVENT,
		]);
		// The spent-budget fallthrough is a final that carries a door: a park the lane trips on, not an
		// end — and the lane sits there until its driver acts.
		expect(defined(summary.tasks.issue).states["human:budget-spent"]).toEqual([
			"UNBLOCKED",
			CLEARED_EVENT,
			CANCELLED_EVENT,
			LANDED_EVENT,
		]);
		expect(summary.trigger).toBeUndefined();
	});

	it("repairs on a FAIL at ship, and parks once the retries are spent", () => {
		const lane = compiled(coderWorkflow());
		// Everything that still reaches ISSUE.FAIL at `ship` names repair — `ROUTED-REPAIR` and
		// `EJECTED` — because the shipper's other refusals map to BLOCKED. `review` owns no verb that
		// moves a branch, so routing there re-verdicted an unchanged head and spent a retry per lap
		// — so this template routes a ship FAIL to repair rather than back to review.
		const roundTrip = ["FAIL", "DONE", "PASS"];
		const repairs = Array.from({length: RETRY_BUDGET}, () => roundTrip).flat();

		expect(leaves(lane, "issue", ["WIP", "DONE", "PASS", ...repairs, "FAIL"])).toEqual([
			"build",
			"review",
			"ship",
			...Array.from({length: RETRY_BUDGET}, () => ["build", "review", "ship"]).flat(),
			"human:budget-spent",
		]);
	});

	it("routes a UI-class lane through build:ui and review:ui, and back to build:ui on a FAIL", () => {
		const lane = compiled(coderWorkflow());

		expect(
			leaves(lane, "issue", ["WIP", "DONE", "PASS", "FAIL", "DONE", "PASS", "PASS"], ["ui"]),
		).toEqual(["build:ui", "review", "review:ui", "build:ui", "review", "review:ui", "ship"]);
	});

	it("leaves a lane carrying no class exactly where it routes today", () => {
		const lane = compiled(coderWorkflow());

		expect(leaves(lane, "issue", ["WIP", "DONE", "PASS", "DONE"])).toEqual([
			"build",
			"review",
			"ship",
			"shipped",
		]);
	});

	it("spends no retry on a class arm — the budget is the repair budget alone", () => {
		const lane = compiled(coderWorkflow());
		const log: LogEntry[] = [];
		const statesOf = () => {
			const fold = foldLog(lane, log);
			if (fold._tag !== "Folded") throw new Error(fold.defects.join("; "));
			return fold.states;
		};
		for (const [index, event] of ["WIP", "DONE", "PASS"].entries()) {
			const applied = applyEvent(
				lane,
				statesOf(),
				"issue",
				event,
				"2026-08-17T00:00:00.000Z",
				index === 0 ? ["ui"] : null,
			);
			if (applied._tag !== "Applied") throw new Error(applied.reason);
			log.push(applied.entry);
		}

		expect(defined(statesOf().issue)).toEqual({
			type: "review:ui",
			was: "review",
			retries: 0,
			maxRetries: RETRY_BUDGET,
			cleared: [],
			classes: ["ui"],
			waits: 0,
			maxWaits: WAIT_BUDGET,
			laps: 0,
			maxLaps: MACHINERY_LAP_BUDGET,
		});
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
			cleared: [],
			classes: [],
			waits: 0,
			maxWaits: WAIT_BUDGET,
			laps: 0,
			maxLaps: MACHINERY_LAP_BUDGET,
		});
		expect([...defined(lane.tasks.park_sweep).errorFinals]).toEqual(["frozen"]);
		expect([...defined(lane.tasks.park_sweep).openFinals]).toEqual(["frozen"]);
	});

	it("holds the chore template to the same operator events as every other lane", () => {
		const summary = topology(compiled(choreWorkflow()));
		const listened = new Set(Object.values(defined(summary.tasks.park_sweep).states).flat());
		// Both injected cells are the compiler's on every lane, so neither is an event this document
		// declares — the six a chore template may listen for are unchanged.
		listened.delete(CLEARED_EVENT);
		listened.delete(CANCELLED_EVENT);
		listened.delete(LANDED_EVENT);

		for (const event of listened) expect(OPERATOR_EVENTS).toContain(event);
	});

	it("refuses a document that declares the clearance itself, on any lane", () => {
		const workflow = twoPhaseWorkflow();
		stateNode(workflow, "task_a", "doing").on[`TASK_A.${CLEARED_EVENT}`] = "checking";

		expect(defectsOf(workflow)).toContain("never a document's transition");
	});

	it("refuses a document that declares a board-proven terminal itself, on any lane", () => {
		for (const event of [CANCELLED_EVENT, LANDED_EVENT]) {
			const workflow = twoPhaseWorkflow();
			stateNode(workflow, "task_a", "doing").on[`TASK_A.${event}`] = "checking";

			expect(defectsOf(workflow)).toContain("never a document's transition");
		}
	});

	it("refuses a document that names a state one of the compiler's board finals owns", () => {
		for (const state of [CANCELLED_STATE, LANDED_STATE]) {
			const workflow = twoPhaseWorkflow();
			regionStates(workflow, "task_a")[state] = {type: "final"};

			expect(defectsOf(workflow)).toContain(
				`state "${state}" is one of the compiler's own board-proven finals`,
			);
		}
	});
});

describe("the compiler — refusals", () => {
	it("refuses an event outside the operator's set, naming them", () => {
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

	it("refuses a guard spelled like a routing one that matches none of the three", () => {
		const workflow = twoPhaseWorkflow();
		stateNode(workflow, "task_a", "doing").on["TASK_A.DONE"] = [
			{target: "checking", guard: "done:diagnosiss"},
			{target: "doing"},
		];

		// Read as the budget guard it would compile, match nothing, spend a wait and land in the arm
		// the routing exists to divert from — the silent fallthrough the namespace is there to stop.
		expect(defectsOf(workflow)).toContain('guarded on "done:diagnosiss"');
	});

	it("leaves a bare guard word the budget guard it has always been", () => {
		const workflow = twoPhaseWorkflow();
		stateNode(workflow, "task_a", "doing").on["TASK_A.DONE"] = [
			{target: "checking", guard: "retriesRemaining"},
			{target: "doing"},
		];

		expect(compile(workflow)._tag).toBe("Compiled");
	});

	it("pins the coder template's compiled cell table", () => {
		expect(cellTable(compiled(coderWorkflow()), "issue")).toEqual(
			readGoldenFixture(import.meta.url, "./__fixtures__/coder.cells.golden.txt"),
		);
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

	it("refuses a seeded class outside the closed set, which would route as unclassed", () => {
		const workflow = twoPhaseWorkflow();
		taskContext(workflow, "task_a").classes = ["UI"];

		expect(defectsOf(workflow)).toContain('context `classes` declares "UI"');
	});

	it("refuses a non-string class entry too — it is no more routable than a misspelling", () => {
		const workflow = twoPhaseWorkflow();
		taskContext(workflow, "task_a").classes = [7];

		expect(defectsOf(workflow)).toContain("context `classes` declares 7");
	});

	it("reads a NON-ARRAY `classes` as silence: declaring nothing is not a defect", () => {
		const workflow = twoPhaseWorkflow();
		taskContext(workflow, "task_a").classes = "ui";

		expect(defined(compiled(workflow).tasks.task_a).initial.classes).toEqual([]);
	});
});

describe("`done:diagnosis` — an investigation's terminal skips the review it opened nothing for", () => {
	const lane = () => compiled(coderWorkflow());

	it("carries a diagnosis-proven DONE straight to `diagnosed`, never through `review`", () => {
		expect(leaves(lane(), "issue", ["WIP", {event: "DONE", diagnosis: true}])).toEqual([
			"build",
			"diagnosed",
		]);
	});

	// All three builder terminals report one DONE, so the fallthrough is what keeps a shipped build
	// and an epic child on the route they have always taken.
	it("leaves a PR-backed DONE — `SHIPPED-PR` — folding to `review`", () => {
		expect(leaves(lane(), "issue", ["WIP", "DONE"])).toEqual(["build", "review"]);
	});

	it("leaves an epic child's DONE — `BUILT-NO-PR` — folding to `review` too", () => {
		// The prover answers `diagnosis` off its no-PR arm alone, and a child's DONE is proven off the
		// commits its range adds; the payload it carries here is the `false` that stands for both.
		expect(leaves(lane(), "issue", ["WIP", {event: "DONE", diagnosis: false}])).toEqual([
			"build",
			"review",
		]);
	});

	it("is a terminal the lane cannot walk out of — nothing follows a finished investigation", () => {
		expect(() =>
			leaves(lane(), "issue", ["WIP", {event: "DONE", diagnosis: true}, "PASS"]),
		).toThrow(/diagnosed/);
	});

	it("spends neither budget reaching it", () => {
		expect(drive(lane(), "issue", ["WIP", {event: "DONE", diagnosis: true}]).state).toMatchObject({
			type: "diagnosed",
			retries: 0,
			waits: 0,
			laps: 0,
		});
	});
});

describe("`merge:partial` — a merge that closed nothing sends the lane round", () => {
	const toShip = ["WIP", "DONE", "PASS"] as const;
	const reached = ["build", "review", "ship"] as const;
	const lane = () => compiled(coderWorkflow());

	it("folds a closing merge to `shipped` exactly as it always did", () => {
		expect(leaves(lane(), "issue", [...toShip, "DONE"])).toEqual([...reached, "shipped"]);
	});

	it("sends a `Part of #N` merge back to `queued`, a state an operator can spawn against", () => {
		expect(leaves(lane(), "issue", [...toShip, {event: "DONE", partial: true}])).toEqual([
			...reached,
			"queued",
		]);
	});

	it("takes the same arm out of the queue dwell, where a partial merge also lands", () => {
		expect(leaves(lane(), "issue", [...toShip, "WIP", {event: "DONE", partial: true}])).toEqual([
			...reached,
			"ship:queued",
			"queued",
		]);
	});

	// The whole point of the divert: the second round can close what the first only part-landed.
	it("folds to `shipped` on the round whose merge does close the issue", () => {
		const round: ReadonlyArray<Step> = [
			...toShip,
			{event: "DONE", partial: true},
			...toShip,
			"DONE",
		];

		expect(leaves(lane(), "issue", round).at(-1)).toBe("shipped");
	});

	// It is neither a repair round nor a wait: the work landed. Spending a counter here would let a
	// lane that shipped three honest partials exhaust the budget its next FAIL draws on.
	it("spends neither budget on the way round", () => {
		const twice: ReadonlyArray<Step> = [
			...toShip,
			{event: "DONE", partial: true},
			...toShip,
			{event: "DONE", partial: true},
		];

		expect(drive(lane(), "issue", twice).state).toMatchObject({
			type: "queued",
			retries: 0,
			waits: 0,
		});
	});
});

describe("`ship:queued` — a proven-clean enqueue is a wait, not a park", () => {
	const toShip = ["WIP", "DONE", "PASS"] as const;
	const reached = ["build", "review", "ship"] as const;

	it("takes a still-queued shipper out of `ship` into the wait cell", () => {
		expect(leaves(compiled(coderWorkflow()), "issue", [...toShip, "WIP"])).toEqual([
			...reached,
			"ship:queued",
		]);
	});

	it("absorbs the late landing a frozen lane could not record — WIP then DONE folds to `shipped`", () => {
		expect(leaves(compiled(coderWorkflow()), "issue", [...toShip, "WIP", "DONE"])).toEqual([
			...reached,
			"ship:queued",
			"shipped",
		]);
	});

	it("re-enters itself for WAIT_BUDGET re-folds, then escalates to its own human park", () => {
		const waiting = Array.from({length: WAIT_BUDGET + 2}, () => "WIP");

		expect(leaves(compiled(coderWorkflow()), "issue", [...toShip, ...waiting])).toEqual([
			...reached,
			...Array.from({length: WAIT_BUDGET + 1}, () => "ship:queued"),
			"human:queue-stall",
		]);
	});

	// A spent wait carries no park cause — `report.ts` refuses one on any non-BLOCKED event — so it
	// keys `parks.ts` on its leaf alone. Landing it in `human:cp-approval` would key the `cause: null`
	// §CP row and clear it by reading an approval nobody was waiting on; its own leaf is what seats it
	// on the queue-moved recipe instead.
	it("escalates to a park the recipe table seats on its own row, never the §CP one", () => {
		const stalled = [...toShip, ...Array.from({length: WAIT_BUDGET + 2}, () => "WIP")];
		const leaf = defined(leaves(compiled(coderWorkflow()), "issue", stalled).at(-1));
		const seated = classifyPark(leaf, null);

		expect(isPark(leaf)).toBe(true);
		expect(seated).toMatchObject({_tag: "Known", recipe: {clearance: "queue-moved"}});
		expect(classifyPark("human:cp-approval", null)).toMatchObject({
			_tag: "Known",
			recipe: {clearance: "cp-approval"},
		});
	});

	it("clears the stall back into the wait cell only on a resume that grants the waits", () => {
		const stalled = [...toShip, ...Array.from({length: WAIT_BUDGET + 2}, () => "WIP")];
		const lane = compiled(coderWorkflow());

		expect(() => leaves(lane, "issue", [...stalled, "UNBLOCKED"])).toThrow(
			/the state comes back and the wait budget does not/,
		);
		expect(leaves(lane, "issue", [...stalled, {event: "UNBLOCKED", waitGrant: 1}]).at(-1)).toBe(
			"ship:queued",
		);
	});

	it("spends `waits`, leaving the repair budget a later FAIL draws on untouched", () => {
		const waiting = Array.from({length: WAIT_BUDGET + 1}, () => "WIP");

		expect(budgets(compiled(coderWorkflow()), "issue", [...toShip, ...waiting])).toMatchObject({
			type: "ship:queued",
			waits: WAIT_BUDGET,
			retries: 0,
		});
	});

	it("routes an ejection out of the wait cell to repair with a full retry budget", () => {
		const lane = compiled(coderWorkflow());
		const ejected = [...toShip, "WIP", "FAIL"];

		expect(leaves(lane, "issue", ejected)).toEqual([...reached, "ship:queued", "build"]);
		expect(budgets(lane, "issue", ejected)).toMatchObject({retries: 1, waits: 0});
	});

	it("still parks a genuine block out of `ship` on `human:cp-approval`", () => {
		expect(leaves(compiled(coderWorkflow()), "issue", [...toShip, "BLOCKED"])).toEqual([
			...reached,
			"human:cp-approval",
		]);
	});

	// A real lane's route out, and the only one permitted: a park is left by a recorded
	// `UNBLOCKED` and never by a second exit cell, so the landing is recorded from the state the lane
	// resumes into rather than from inside the park.
	it("leaves a park over a merged PR by UNBLOCKED, then records the landing", () => {
		expect(
			leaves(compiled(coderWorkflow()), "issue", [...toShip, "BLOCKED", "UNBLOCKED", "DONE"]),
		).toEqual([...reached, "human:cp-approval", "ship", "shipped"]);
	});

	it("refuses a DONE inside the park rather than opening a second exit from it", () => {
		expect(() =>
			leaves(compiled(coderWorkflow()), "issue", [...toShip, "BLOCKED", "DONE"]),
		).toThrow(/DONE/);
	});
});

describe("`ship` FAIL routes to repair, and a base-drift stop spends nothing", () => {
	const toShip = ["WIP", "DONE", "PASS"] as const;
	const reached = ["build", "review", "ship"] as const;

	it("lands a FAIL folded from `ship` on `build`, with the retry spent", () => {
		const lane = compiled(coderWorkflow());

		expect(leaves(lane, "issue", [...toShip, "FAIL"])).toEqual([...reached, "build"]);
		expect(budgets(lane, "issue", [...toShip, "FAIL"])).toMatchObject({
			type: "build",
			retries: 1,
			waits: 0,
		});
	});

	// The exhaustion the raised cap is only half of: the other half is where it lands. `frozen` is no
	// park to `isPark`, so `recipe unpark` answered `NotParked` and the one door left was
	// `build clear` — PR-keyed, and an epic child opens no PR. The leaf is a park now, and its
	// structural cause routes it to the driver.
	it("parks at `ship` on a driver-routed leaf once the repair budget is spent", () => {
		const lane = compiled(coderWorkflow());
		const spent = [
			...toShip,
			...Array.from({length: RETRY_BUDGET}, () => ["FAIL", "DONE", "PASS"]).flat(),
			"FAIL",
		];

		const leaf = defined(leaves(lane, "issue", spent).at(-1));
		expect(leaf).toBe("human:budget-spent");
		expect(budgets(lane, "issue", spent)).toMatchObject({
			type: "human:budget-spent",
			retries: RETRY_BUDGET,
		});
		expect(isPark(leaf)).toBe(true);
		expect(classifyPark(leaf, null)).toMatchObject({
			_tag: "Novel",
			cause: "repair-budget-spent",
		});
		expect(routeForCause("repair-budget-spent")).toBe("driver");
	});

	it("maps the drift stop's terminal to BLOCKED and takes its cause", () => {
		const resolved = eventForToken("AWAITING-CP-APPROVAL");
		if (resolved._tag !== "Mapped") throw new Error(resolved.reason);

		expect(resolved.event).toBe("BLOCKED");
		expect(causeForEvent("head-behind-base", resolved.event, false)).toEqual({
			_tag: "Caused",
			cause: "head-behind-base",
		});
	});

	// The whole reported harm: three lanes froze at 2/2 over drift alone, with no defect in the work
	// and every namespace PASS at the head the reviewer re-read.
	it("spends neither budget when that terminal folds from `ship`", () => {
		const lane = compiled(coderWorkflow());
		const before = budgets(lane, "issue", [...toShip]);
		const parked = driven(lane, "issue", [...toShip, "BLOCKED"], "head-behind-base");

		expect(parked.cause).toBe("head-behind-base");
		expect(parked.state).toMatchObject({
			type: "human:cp-approval",
			retries: before.retries,
			waits: before.waits,
		});
	});

	// No `KNOWN_PARKS` row exists for this cause and none is owed yet: clearing it needs a verb that
	// merges the base into the head, and `build` ships none. Novel-naming-the-cause is the answer.
	it("reads as a novel park that names its cause, never as the causeless §CP row", () => {
		const classified = classifyPark("human:cp-approval", "head-behind-base");

		expect(classified._tag).toBe("Novel");
		if (classified._tag === "Novel") expect(classified.reason).toContain("head-behind-base");
	});
});
