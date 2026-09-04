import {describe, expect, it} from "vitest";
import {readGoldenFixture} from "../golden-fixture.ts";
import {classifyPark, isPark} from "../recipe/parks.ts";
import {WAIT_BUDGET} from "../wait-budget.ts";
import {
	choreWorkflow,
	coderWorkflow,
	stateNode,
	twoPhaseWorkflow,
} from "./fixtures.test-support.ts";
import {applyEvent, foldLog, type LogEntry, standingCauses} from "./fold.ts";
import {
	CLEARED_EVENT,
	type CompiledLane,
	compile,
	type LaneMsg,
	OPERATOR_EVENTS,
	type TaskState,
	topology,
} from "./machine.ts";
import {causeForEvent, eventForToken} from "./report.ts";

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
 * grants (ADR 0313), or whether the merge it reports left the issue open (ADR 0343).
 */
type Step =
	| string
	| {readonly event: string; readonly waitGrant?: number; readonly partial?: boolean};

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
 * rather than machine state (#6480) — the fold derives it back from there.
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
				for (const retries of [0, 2]) {
					// One "spent" axis drives both counters, so the 2/2 rows pin the fallthrough of a
					// FAIL arm and of a wait arm alike without doubling the table again (ADR 0313).
					const from: TaskState = {
						type: state,
						retries,
						maxRetries: 2,
						cleared: [],
						classes: [],
						waits: retries === 0 ? 0 : WAIT_BUDGET,
						maxWaits: WAIT_BUDGET,
						was: "review",
					};
					const [next] = defined(cells[event])(from, {type: event, classes});
					const carried = classes.length === 0 ? "-" : classes.join(",");
					rows.push(
						`${state}\t${event}\t${carried}\t${retries}/2\t-> ${next.type}\t${next.retries}/2`,
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
		expect(defined(lane.tasks.issue).initial).toEqual({
			type: "queued",
			retries: 0,
			maxRetries: 2,
			cleared: [],
			classes: [],
			waits: 0,
			maxWaits: WAIT_BUDGET,
		});
		expect([...defined(lane.tasks.issue).finals].sort()).toEqual(["frozen", "shipped"]);
		expect([...defined(lane.tasks.issue).errorFinals]).toEqual(["frozen"]);
		expect([...defined(lane.tasks.issue).openFinals]).toEqual(["frozen"]);
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
		// — not a fall back into the error final a resume just left, so it is no resume hazard (#6570).
		stateNode(workflow, "task_a", "doing").on["TASK_A.WIP"] = [
			{target: "doing"},
			{target: "tripped"},
		];

		const lane = compiled(workflow);

		expect([...defined(lane.tasks.task_a).guardedStates]).toEqual(["checking"]);
	});

	it("leaves every final an end but `frozen`, though all of them take a clearance", () => {
		const summary = topology(compiled(coderWorkflow()));

		// The injected cell is on `shipped` too, and it must not make `shipped` a park: an open final
		// is one the DOCUMENT left a door in, and a clearance is a door out of nothing (ADR 0312).
		expect(defined(summary.tasks.issue).states.shipped).toEqual([CLEARED_EVENT]);
		expect([...defined(compiled(coderWorkflow()).tasks.issue).openFinals]).toEqual(["frozen"]);
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

		// Every state also holds the compiler's own `CLEARED` cell (ADR 0312), which no document declares.
		expect(defined(summary.tasks.issue).states.queued).toEqual(["WIP", "BLOCKED", CLEARED_EVENT]);
		expect(defined(summary.tasks.issue).states.review).toEqual([
			"PASS",
			"BLOCKED",
			"FAIL",
			CLEARED_EVENT,
		]);
		expect(defined(summary.tasks.issue).states.ship).toEqual([
			"DONE",
			"WIP",
			"BLOCKED",
			"FAIL",
			CLEARED_EVENT,
		]);
		expect(defined(summary.tasks.issue).states["ship:queued"]).toEqual([
			"DONE",
			"BLOCKED",
			"WIP",
			"FAIL",
			CLEARED_EVENT,
		]);
		expect(defined(summary.tasks.issue).states.shipped).toEqual([CLEARED_EVENT]);
		// `frozen` is a final that carries a door: a park the lane trips on, not an end (ADR 0297).
		expect(defined(summary.tasks.issue).states.frozen).toEqual(["UNBLOCKED", CLEARED_EVENT]);
		expect(summary.trigger).toBeUndefined();
	});

	it("repairs on a FAIL at ship, and freezes once the retries are spent (#5807, #6826)", () => {
		const lane = compiled(coderWorkflow());
		// Everything that still reaches ISSUE.FAIL at `ship` names repair — `ROUTED-REPAIR` and
		// `EJECTED` — because the shipper's other refusals map to BLOCKED. `review` owns no verb that
		// moves a branch, so routing there re-verdicted an unchanged head and spent a retry per lap
		// (#6826, reverting ADR 0317's arm for this template only).
		const roundTrip = ["FAIL", "DONE", "PASS"];

		expect(
			leaves(lane, "issue", ["WIP", "DONE", "PASS", ...roundTrip, ...roundTrip, "FAIL"]),
		).toEqual([
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
			maxRetries: 2,
			cleared: [],
			classes: ["ui"],
			waits: 0,
			maxWaits: WAIT_BUDGET,
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
		});
		expect([...defined(lane.tasks.park_sweep).errorFinals]).toEqual(["frozen"]);
		expect([...defined(lane.tasks.park_sweep).openFinals]).toEqual(["frozen"]);
	});

	it("holds the chore template to the same six events as every other lane", () => {
		const summary = topology(compiled(choreWorkflow()));
		const listened = new Set(Object.values(defined(summary.tasks.park_sweep).states).flat());
		// The clearance is the compiler's cell on every lane, so it is not a seventh event this
		// document declares — the six a chore template may listen for are unchanged.
		listened.delete(CLEARED_EVENT);

		for (const event of listened) expect(OPERATOR_EVENTS).toContain(event);
	});

	it("refuses a document that declares the clearance itself, on any lane", () => {
		const workflow = twoPhaseWorkflow();
		stateNode(workflow, "task_a", "doing").on[`TASK_A.${CLEARED_EVENT}`] = "checking";

		expect(defectsOf(workflow)).toContain("never a document's transition");
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
});

describe("`merge:partial` — a merge that closed nothing sends the lane round (ADR 0343)", () => {
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

describe("`ship:queued` — a proven-clean enqueue is a wait, not a park (ADR 0313)", () => {
	const toShip = ["WIP", "DONE", "PASS"] as const;
	const reached = ["build", "review", "ship"] as const;

	it("takes a still-queued shipper out of `ship` into the wait cell", () => {
		expect(leaves(compiled(coderWorkflow()), "issue", [...toShip, "WIP"])).toEqual([
			...reached,
			"ship:queued",
		]);
	});

	it("absorbs the late landing lane 6462 could not record — WIP then DONE folds to `shipped`", () => {
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
	// on the queue-moved recipe instead (#6717).
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

	it("still parks a genuine block out of `ship` on `human:cp-approval` (#5820 untouched)", () => {
		expect(leaves(compiled(coderWorkflow()), "issue", [...toShip, "BLOCKED"])).toEqual([
			...reached,
			"human:cp-approval",
		]);
	});

	// Lane 6462's real route out, and the only one ADR 0302 permits: a park is left by a recorded
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

describe("`ship` FAIL routes to repair, and a base-drift stop spends nothing (#6826)", () => {
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

	it("freezes at `ship` once the repair budget is spent, leaving the frozen arm as it was", () => {
		const lane = compiled(coderWorkflow());
		const spent = [...toShip, "FAIL", "DONE", "PASS", "FAIL", "DONE", "PASS", "FAIL"];

		expect(defined(leaves(lane, "issue", spent).at(-1))).toBe("frozen");
		expect(budgets(lane, "issue", spent)).toMatchObject({type: "frozen", retries: 2});
	});

	it("maps the drift stop's terminal to BLOCKED and takes its cause", () => {
		const resolved = eventForToken("AWAITING-CP-APPROVAL");
		if (resolved._tag !== "Mapped") throw new Error(resolved.reason);

		expect(resolved.event).toBe("BLOCKED");
		expect(causeForEvent("head-behind-base", resolved.event)).toEqual({
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
