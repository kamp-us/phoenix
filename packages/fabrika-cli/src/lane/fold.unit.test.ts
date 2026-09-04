/**
 * The six-event contract, tested as the spike's recorded runs (#5671 run 8 and 19; the
 * state-ledger rebuild's runs 1–6 recorded on #5570's 2026-08-15 session note are the plan).
 */
import {describe, expect, it} from "vitest";
import {CAP_ROUND, RETRY_BUDGET} from "../retry-budget.ts";
import {WAIT_BUDGET} from "../wait-budget.ts";
import {coderWorkflow, twoPhaseWorkflow} from "./fixtures.test-support.ts";
import {
	applyClearance,
	applyEvent,
	deriveStatus,
	foldLog,
	type LogEntry,
	nextLeaf,
	parseLog,
	resolveTask,
	standingCauses,
} from "./fold.ts";
import {CLEARED_EVENT, type CompiledLane, compile} from "./machine.ts";

const lane = (workflow: unknown): CompiledLane => {
	const result = compile(workflow);
	if (result._tag !== "Compiled") throw new Error(result.defects.join("; "));
	return result.lane;
};

const entry = (task: string, event: string): LogEntry => ({
	task,
	event: `${task.toUpperCase()}.${event}`,
	at: "2026-08-16T00:00:00.000Z",
});

/** Drive a sequence through applyEvent, asserting every step is accepted. */
const drive = (
	compiled: CompiledLane,
	steps: ReadonlyArray<readonly [string, string]>,
	from: ReadonlyArray<LogEntry> = [],
) => {
	const log: LogEntry[] = [...from];
	for (const [task, event] of steps) {
		const states = statesOf(compiled, log);
		const applied = applyEvent(compiled, states, task, event, "2026-08-16T00:00:00.000Z");
		if (applied._tag !== "Applied") throw new Error(`${task} ${event}: ${applied.reason}`);
		log.push(applied.entry);
	}
	return log;
};

const statesOf = (compiled: CompiledLane, log: ReadonlyArray<LogEntry>) => {
	const fold = foldLog(compiled, log);
	if (fold._tag !== "Folded") throw new Error(fold.defects.join("; "));
	return fold.states;
};

const statusOf = (compiled: CompiledLane, log: ReadonlyArray<LogEntry>) =>
	deriveStatus(compiled, statesOf(compiled, log));

/** Append one founder-cleared round the way `build clear` does — an event, never a context edit. */
const grant = (
	compiled: CompiledLane,
	log: ReadonlyArray<LogEntry>,
	task: string,
	round: number,
): ReadonlyArray<LogEntry> => {
	const applied = applyClearance(compiled, log, task, round, "2026-08-16T00:00:00.000Z");
	if (applied._tag !== "Appendable") throw new Error(`grant ${round}: ${applied._tag}`);
	return [...log, applied.entry];
};

describe("run 1 — a fresh lane's status shape", () => {
	it("answers the compound stateValue with future phases waiting and errors empty", () => {
		const compiled = lane(twoPhaseWorkflow());

		expect(statusOf(compiled, [])).toEqual({
			stateValue: {
				phase1: {task_a: "doing", task_b: "doing"},
				phase2: "waiting",
			},
			status: "active",
			context: {
				task_a: {retries: 0, maxRetries: 2, waits: 0, maxWaits: WAIT_BUDGET, code: true},
				task_b: {retries: 0, maxRetries: 3, waits: 0, maxWaits: WAIT_BUDGET, code: false},
				task_c: {retries: 0, maxRetries: 3, waits: 0, maxWaits: WAIT_BUDGET, code: true},
				errors: [],
			},
		});
	});

	it("carries the standing lane classes in status, and nothing when none stand (ADR 0317)", () => {
		const compiled = lane(coderWorkflow());
		const states = statesOf(compiled, []);
		const at = "2026-08-16T00:00:00.000Z";
		const applied = applyEvent(compiled, states, "issue", "WIP", at, ["ui"]);
		if (applied._tag !== "Applied") throw new Error(applied.reason);

		// The driver relays this back onto the next event's `--class`; unclassed stays key-absent, so
		// a lane that never raised one reads exactly as it always did.
		expect(statusOf(compiled, [applied.entry]).context.issue).toMatchObject({classes: ["ui"]});
		expect(statusOf(compiled, []).context.issue).not.toHaveProperty("classes");
	});
});

describe("run 2 — the happy path", () => {
	it("gates phase1 → phase2 on the last PASS and lands on the complete terminal", () => {
		const compiled = lane(twoPhaseWorkflow());
		const log = drive(compiled, [
			["task_a", "DONE"],
			["task_a", "PASS"],
			["task_b", "DONE"],
			["task_b", "PASS"],
			["task_c", "DONE"],
			["task_c", "PASS"],
		]);

		expect(statusOf(compiled, log)).toMatchObject({stateValue: "complete", status: "done"});
	});

	it("walks the coder template queued → build → review → ship → shipped → complete", () => {
		const compiled = lane(coderWorkflow());
		const log = drive(compiled, [
			["issue", "WIP"],
			["issue", "DONE"],
			["issue", "PASS"],
			["issue", "DONE"],
		]);

		expect(statusOf(compiled, log)).toMatchObject({stateValue: "complete", status: "done"});
	});
});

describe("run 3 — FAIL with retries remaining", () => {
	it("returns to the retry target and increments retries in context", () => {
		const compiled = lane(twoPhaseWorkflow());
		const log = drive(compiled, [
			["task_a", "DONE"],
			["task_a", "FAIL"],
		]);

		const status = statusOf(compiled, log);
		expect(status.stateValue).toMatchObject({phase1: {task_a: "doing"}});
		expect(status.context.task_a).toMatchObject({retries: 1, maxRetries: 2});
	});
});

describe("run 4 — exhaustion, sibling isolation, and the noErrors gate", () => {
	const exhausted = () => {
		const compiled = lane(twoPhaseWorkflow());
		// task_a has maxRetries 2: two retried FAILs, then the third falls through to tripped.
		const log = drive(compiled, [
			["task_a", "DONE"],
			["task_a", "FAIL"],
			["task_a", "DONE"],
			["task_a", "FAIL"],
			["task_a", "DONE"],
			["task_a", "FAIL"],
		]);
		return {compiled, log};
	};

	it("falls through to the error final at the retry budget — freeze-after-2 as data", () => {
		const {compiled, log} = exhausted();

		const status = statusOf(compiled, log);
		expect(status.stateValue).toMatchObject({phase1: {task_a: "tripped"}});
		expect(status.status).toBe("active");
		expect(status.context.errors).toEqual(["task_a"]);
	});

	it("keeps the sibling moving after the trip, then trips the workflow at the gate", () => {
		const {compiled, log} = exhausted();

		const done = applyEvent(
			compiled,
			statesOf(compiled, log),
			"task_b",
			"DONE",
			"2026-08-16T00:00:00.000Z",
		);
		expect(done._tag).toBe("Applied");
		if (done._tag !== "Applied") return;

		const pass = applyEvent(
			compiled,
			statesOf(compiled, [...log, done.entry]),
			"task_b",
			"PASS",
			"2026-08-16T00:00:00.000Z",
		);
		expect(pass._tag).toBe("Applied");
		if (pass._tag !== "Applied") return;
		expect(pass.current).toMatchObject({stateValue: "tripped", status: "done"});
	});
});

describe("run 5 — BLOCKED then UNBLOCKED resumes the state it left", () => {
	it("resumes at the pre-blocked state via `was`, not at the initial state", () => {
		const compiled = lane(twoPhaseWorkflow());
		const log = drive(compiled, [
			["task_a", "DONE"],
			["task_a", "BLOCKED"],
			["task_a", "UNBLOCKED"],
		]);

		expect(statusOf(compiled, log).stateValue).toMatchObject({phase1: {task_a: "checking"}});
	});

	it("routes ship BLOCKED to human:cp-approval and resumes ship on UNBLOCKED", () => {
		const compiled = lane(coderWorkflow());
		const log = drive(compiled, [
			["issue", "WIP"],
			["issue", "DONE"],
			["issue", "PASS"],
			["issue", "BLOCKED"],
		]);
		expect(statusOf(compiled, log).stateValue).toMatchObject({
			pipeline: {issue: "human:cp-approval"},
		});

		const applied = applyEvent(
			compiled,
			statesOf(compiled, log),
			"issue",
			"UNBLOCKED",
			"2026-08-16T00:00:00.000Z",
		);
		expect(applied._tag).toBe("Applied");
		if (applied._tag === "Applied") {
			expect(applied.current.stateValue).toMatchObject({pipeline: {issue: "ship"}});
		}
	});
});

describe("the frozen park — an UNBLOCKED door out of an error final (ADR 0297)", () => {
	const round: ReadonlyArray<readonly [string, string]> = [
		["issue", "DONE"],
		["issue", "FAIL"],
	];
	/** WIP, then a FAIL per round until the budget is spent and the last one freezes the task. */
	const freeze: ReadonlyArray<readonly [string, string]> = [
		["issue", "WIP"],
		...Array.from({length: RETRY_BUDGET + 1}, () => round).flat(),
	];

	it("trips the lane on the frozen task rather than hanging its phase", () => {
		const compiled = lane(coderWorkflow());

		const status = statusOf(compiled, drive(compiled, freeze));
		expect(status).toMatchObject({stateValue: "tripped", status: "done"});
		expect(status.context.errors).toEqual(["issue"]);
		expect(status.context.issue).toMatchObject({retries: RETRY_BUDGET, maxRetries: RETRY_BUDGET});
	});

	it("refuses the door when the state would come back and the budget would not (#6570)", () => {
		const compiled = lane(coderWorkflow());

		const applied = applyEvent(
			compiled,
			statesOf(compiled, drive(compiled, freeze)),
			"issue",
			"UNBLOCKED",
			"2026-08-16T00:00:00.000Z",
		);
		// Never a silent `active`/`review` whose only walkable arm is PASS: the resume is refused with
		// the log unappended, and the refusal names the remedy (ADR 0312).
		expect(applied).toMatchObject({_tag: "Refused", kind: "unbudgeted-resume"});
		if (applied._tag !== "Refused") return;
		expect(applied.reason).toContain("build clear");
		expect(applied.reason).toContain(`${RETRY_BUDGET}/${RETRY_BUDGET} retries`);
	});

	it("opens the door once a CLEARED is in the log, in either order", () => {
		const compiled = lane(coderWorkflow());
		const frozen = drive(compiled, freeze);

		// Grant then resume, and resume-after-grant on the same log: one order, because the budget is
		// a fold over the events before each position rather than a value read at replay time.
		const resumed = drive(
			compiled,
			[["issue", "UNBLOCKED"]],
			grant(compiled, frozen, "issue", CAP_ROUND),
		);
		expect(statusOf(compiled, resumed)).toMatchObject({
			stateValue: {pipeline: {issue: "review"}},
			status: "active",
		});
		expect(statusOf(compiled, resumed).context.issue).toMatchObject({
			retries: RETRY_BUDGET,
			maxRetries: RETRY_BUDGET + 1,
			clearedRounds: [CAP_ROUND],
		});
		expect(statusOf(compiled, resumed).context.errors).toEqual([]);
	});

	it("spends the granted round exactly once — the next FAIL freezes again", () => {
		const compiled = lane(coderWorkflow());
		const resumed = drive(
			compiled,
			[["issue", "UNBLOCKED"]],
			grant(compiled, drive(compiled, freeze), "issue", CAP_ROUND),
		);

		// The granted round is walkable: FAIL routes to `build`, not straight back to `frozen`.
		const spent = drive(compiled, [["issue", "FAIL"]], resumed);
		expect(statusOf(compiled, spent).stateValue).toMatchObject({pipeline: {issue: "build"}});
		expect(statusOf(compiled, drive(compiled, round, spent))).toMatchObject({
			stateValue: "tripped",
			status: "done",
		});
	});

	it("re-recording the same grant buys nothing — CLEARED is keyed by its round", () => {
		const compiled = lane(coderWorkflow());
		const once = grant(compiled, drive(compiled, freeze), "issue", CAP_ROUND);
		const twice = [...once, {...once[once.length - 1]} as LogEntry];

		expect(statusOf(compiled, twice).context.issue).toMatchObject({
			maxRetries: RETRY_BUDGET + 1,
			clearedRounds: [CAP_ROUND],
		});
		expect(
			applyClearance(compiled, once, "issue", CAP_ROUND, "2026-08-16T00:00:00.000Z"),
		).toMatchObject({_tag: "AlreadyHeld"});
	});

	it("a grant landing on the park moves nothing — the door out is still UNBLOCKED (ADR 0297)", () => {
		const compiled = lane(coderWorkflow());
		const granted = grant(compiled, drive(compiled, freeze), "issue", CAP_ROUND);

		expect(statusOf(compiled, granted)).toMatchObject({stateValue: "tripped", status: "done"});
		expect(statusOf(compiled, granted).context.errors).toEqual(["issue"]);
	});

	it("refuses the door on a region booted in the park — there is no state to resume", () => {
		const workflow = coderWorkflow() as {
			machine: {states: {pipeline: {states: {issue: {initial: string}}}}};
		};
		workflow.machine.states.pipeline.states.issue.initial = "frozen";
		const compiled = lane(workflow);

		const applied = applyEvent(
			compiled,
			statesOf(compiled, []),
			"issue",
			"UNBLOCKED",
			"2026-08-16T00:00:00.000Z",
		);
		expect(applied).toMatchObject({_tag: "Refused"});
		if (applied._tag === "Refused") expect(applied.reason).toContain("no state to resume");
	});

	/** twoPhaseWorkflow with task_a's `tripped` turned into a park, optionally booted into it. */
	const parkedSibling = (booted: boolean): Record<string, unknown> => {
		const workflow = twoPhaseWorkflow();
		const region = (
			workflow.machine as {
				states: {phase1: {states: {task_a: {initial: string; states: Record<string, unknown>}}}};
			}
		).states.phase1.states.task_a;
		region.states.tripped = {type: "final", on: {"TASK_A.UNBLOCKED": "hist"}};
		if (booted) region.initial = "tripped";
		return workflow;
	};

	it("refuses the booted park's door while a sibling keeps the phase active", () => {
		const compiled = lane(parkedSibling(true));

		// The phase never folds — task_b is still `doing` — so the lane reads active and the whole
		// tripped-terminal path is unreachable; the self-loop has to be caught on the task itself.
		expect(statusOf(compiled, []).status).toBe("active");
		const applied = applyEvent(
			compiled,
			statesOf(compiled, []),
			"task_a",
			"UNBLOCKED",
			"2026-08-16T00:00:00.000Z",
		);
		expect(applied).toMatchObject({_tag: "Refused"});
		if (applied._tag === "Refused") expect(applied.reason).toContain("no state to resume");
	});

	it("still resumes a park the task walked into, with the phase active around it", () => {
		const compiled = lane(parkedSibling(false));

		const log = drive(compiled, [
			["task_a", "DONE"],
			["task_a", "FAIL"],
			["task_a", "DONE"],
			["task_a", "FAIL"],
			["task_a", "DONE"],
			["task_a", "FAIL"],
		]);
		expect(statusOf(compiled, log)).toMatchObject({
			stateValue: {phase1: {task_a: "tripped", task_b: "doing"}},
			status: "active",
		});
		const applied = applyEvent(
			compiled,
			statesOf(compiled, grant(compiled, log, "task_a", CAP_ROUND)),
			"task_a",
			"UNBLOCKED",
			"2026-08-16T00:00:00.000Z",
		);
		expect(applied._tag).toBe("Applied");
		if (applied._tag !== "Applied") return;
		expect(applied.current.stateValue).toMatchObject({phase1: {task_a: "checking"}});
	});

	it("refuses that same park's door with no grant behind it, phase active or not", () => {
		const compiled = lane(parkedSibling(false));
		const log = drive(compiled, [
			["task_a", "DONE"],
			["task_a", "FAIL"],
			["task_a", "DONE"],
			["task_a", "FAIL"],
			["task_a", "DONE"],
			["task_a", "FAIL"],
		]);

		const applied = applyEvent(
			compiled,
			statesOf(compiled, log),
			"task_a",
			"UNBLOCKED",
			"2026-08-16T00:00:00.000Z",
		);
		expect(applied).toMatchObject({_tag: "Refused", kind: "unbudgeted-resume"});
	});

	it("still refuses an event the park holds no cell for", () => {
		const compiled = lane(coderWorkflow());

		const applied = applyEvent(
			compiled,
			statesOf(compiled, drive(compiled, freeze)),
			"issue",
			"DONE",
			"2026-08-16T00:00:00.000Z",
		);
		expect(applied).toMatchObject({_tag: "Refused"});
		if (applied._tag === "Refused") expect(applied.reason).toContain("NoCellError");
	});
});

/**
 * The incident this slice closes, driven end to end: lane 6462 / PR #6552, where the two halves of
 * one frozen-lane resume were applied in the order a human applies them and produced two defects
 * (#6570, #6578). Both are asserted absent here on the same log.
 */
describe("lane 6462 — an UNBLOCKED, then a `build clear` for that round (#6570, #6578)", () => {
	const round: ReadonlyArray<readonly [string, string]> = [
		["issue", "DONE"],
		["issue", "FAIL"],
	];
	const freeze: ReadonlyArray<readonly [string, string]> = [
		["issue", "WIP"],
		...Array.from({length: RETRY_BUDGET + 1}, () => round).flat(),
	];

	it("refuses the UNBLOCKED that folded with no budget rather than advertising `active`", () => {
		const compiled = lane(coderWorkflow());
		const frozen = drive(compiled, freeze);

		// #6570: the fold restored `review` at retries 2 against maxRetries 2, so `ISSUE.PASS` was the
		// only non-error arm and the lane still read `active` — the signal an operator routes on.
		expect(statusOf(compiled, frozen).context.issue).toMatchObject({
			retries: RETRY_BUDGET,
			maxRetries: RETRY_BUDGET,
		});
		const applied = applyEvent(
			compiled,
			statesOf(compiled, frozen),
			"issue",
			"UNBLOCKED",
			"2026-08-20T19:00:00.000Z",
		);
		expect(applied).toMatchObject({_tag: "Refused", kind: "unbudgeted-resume"});
	});

	it("keeps the log replayable when the grant lands after the resume", () => {
		const compiled = lane(coderWorkflow());
		// The historical order, now reachable: the grant is what admits the UNBLOCKED, and appending a
		// second grant afterwards must not re-route either of them.
		const frozen = drive(compiled, freeze);
		const resumed = drive(
			compiled,
			[["issue", "UNBLOCKED"]],
			grant(compiled, frozen, "issue", CAP_ROUND),
		);
		const later = grant(compiled, resumed, "issue", CAP_ROUND + 1);

		// #6578: the third FAIL used to re-evaluate against the widened budget, route to `build`
		// instead of `frozen`, and strand the recorded UNBLOCKED in a state with no cell for it —
		// every verb then refused on exit 4. The fold is clean, and the FAIL kept its routing.
		const fold = foldLog(compiled, later);
		expect(fold._tag).toBe("Folded");
		expect(statusOf(compiled, later)).toMatchObject({
			stateValue: {pipeline: {issue: "review"}},
			status: "active",
		});
		expect(statusOf(compiled, later).context.issue).toMatchObject({
			retries: RETRY_BUDGET,
			maxRetries: RETRY_BUDGET + 2,
			clearedRounds: [CAP_ROUND, CAP_ROUND + 1],
		});
	});

	it("re-folds identically however many times the same log is read", () => {
		const compiled = lane(coderWorkflow());
		const log = drive(
			compiled,
			[["issue", "UNBLOCKED"]],
			grant(compiled, drive(compiled, freeze), "issue", CAP_ROUND),
		);

		expect(statesOf(compiled, log)).toEqual(statesOf(compiled, log));
		// Every prefix replays too — the property a budget read out of mutable context could not hold.
		for (let cut = 0; cut <= log.length; cut += 1) {
			expect(foldLog(compiled, log.slice(0, cut))._tag).toBe("Folded");
		}
	});
});

describe("run 6 — invalid events refuse, producing nothing to append", () => {
	it("refuses an event the current state holds no cell for, on tea's NoCellError surface", () => {
		const compiled = lane(twoPhaseWorkflow());

		const applied = applyEvent(
			compiled,
			statesOf(compiled, []),
			"task_a",
			"PASS",
			"2026-08-16T00:00:00.000Z",
		);
		expect(applied).toMatchObject({_tag: "Refused"});
		if (applied._tag === "Refused") expect(applied.reason).toContain("NoCellError");
	});

	it("refuses an event outside the operator's six before touching the machine", () => {
		const compiled = lane(twoPhaseWorkflow());

		const applied = applyEvent(
			compiled,
			statesOf(compiled, []),
			"task_a",
			"MERGE",
			"2026-08-16T00:00:00.000Z",
		);
		expect(applied).toMatchObject({_tag: "Refused"});
		if (applied._tag === "Refused") expect(applied.reason).toContain("six");
	});

	it("refuses a CLEARED handed to the operator's path, naming the verb that appends one", () => {
		const compiled = lane(twoPhaseWorkflow());

		// The cell exists in every state, so nothing in the machine would stop this — the refusal is
		// what keeps `lane transition` from minting budget nobody granted (ADR 0312).
		const applied = applyEvent(
			compiled,
			statesOf(compiled, []),
			"task_a",
			CLEARED_EVENT,
			"2026-08-16T00:00:00.000Z",
		);
		expect(applied).toMatchObject({_tag: "Refused", kind: "event"});
		if (applied._tag === "Refused") expect(applied.reason).toContain("build clear");
	});

	it("refuses a task outside the active phase", () => {
		const compiled = lane(twoPhaseWorkflow());

		const applied = applyEvent(
			compiled,
			statesOf(compiled, []),
			"task_c",
			"DONE",
			"2026-08-16T00:00:00.000Z",
		);
		expect(applied).toMatchObject({_tag: "Refused"});
		if (applied._tag === "Refused") expect(applied.reason).toContain("active phase");
	});

	it("refuses any further event once the workflow is done", () => {
		const compiled = lane(coderWorkflow());
		const log = drive(compiled, [
			["issue", "WIP"],
			["issue", "DONE"],
			["issue", "PASS"],
			["issue", "DONE"],
		]);

		const applied = applyEvent(
			compiled,
			statesOf(compiled, log),
			"issue",
			"DONE",
			"2026-08-16T00:00:00.000Z",
		);
		expect(applied).toMatchObject({_tag: "Refused"});
		if (applied._tag === "Refused") expect(applied.reason).toContain("no further events");
	});
});

describe("the fold is deterministic and total over its inputs", () => {
	it("folds the same log to the same states every time", () => {
		const compiled = lane(twoPhaseWorkflow());
		const log = drive(compiled, [
			["task_a", "DONE"],
			["task_b", "DONE"],
			["task_a", "FAIL"],
		]);

		expect(statesOf(compiled, log)).toEqual(statesOf(compiled, log));
	});

	it("refuses to fold a log naming a task the machine does not have", () => {
		const compiled = lane(twoPhaseWorkflow());

		const fold = foldLog(compiled, [entry("task_z", "DONE")]);
		expect(fold).toMatchObject({_tag: "Unreplayable"});
	});

	it("refuses to fold a log the machine holds no cell for — a hand edit, named", () => {
		const compiled = lane(twoPhaseWorkflow());

		const fold = foldLog(compiled, [entry("task_a", "PASS")]);
		expect(fold).toMatchObject({_tag: "Unreplayable"});
		if (fold._tag === "Unreplayable") expect(fold.defects.join()).toContain("does not replay");
	});

	it("parses only whole well-formed lines, naming each defective one", () => {
		const good = JSON.stringify(entry("task_a", "DONE"));

		expect(parseLog(`${good}\n`)).toMatchObject({_tag: "Parsed"});
		expect(parseLog(`${good}\nnot json\n`)).toMatchObject({
			_tag: "Malformed",
			defects: ["line 2 is not JSON"],
		});
		expect(parseLog(`{"task":"task_a"}\n`)).toMatchObject({_tag: "Malformed"});
	});

	it("resolves an omitted --task only when the machine leaves no choice", () => {
		expect(resolveTask(lane(coderWorkflow()), null)).toEqual({_tag: "Task", taskId: "issue"});
		expect(resolveTask(lane(twoPhaseWorkflow()), null)).toMatchObject({_tag: "Unresolved"});
		expect(resolveTask(lane(coderWorkflow()), "nope")).toMatchObject({_tag: "Unresolved"});
	});
});

describe("nextLeaf — the arm an event would take, asked before it is recorded (#6664)", () => {
	const atReview = () => {
		const compiled = lane(coderWorkflow());
		return {
			compiled,
			states: statesOf(
				compiled,
				drive(compiled, [
					["issue", "WIP"],
					["issue", "DONE"],
				]),
			),
		};
	};

	it("routes a review PASS into `review:ui` only when the ui class rides on it", () => {
		const {compiled, states} = atReview();

		expect(nextLeaf(compiled, states, "issue", "PASS", ["ui"])).toBe("review:ui");
		expect(nextLeaf(compiled, states, "issue", "PASS", null)).toBe("ship");
		expect(nextLeaf(compiled, states, "issue", "PASS", ["code"])).toBe("ship");
	});

	it("answers null where the machine holds no cell for the event, rather than guessing one", () => {
		const {compiled, states} = atReview();

		expect(nextLeaf(compiled, states, "issue", "UNBLOCKED", null)).toBeNull();
		expect(nextLeaf(compiled, states, "issue", "NOPE", null)).toBeNull();
		expect(nextLeaf(compiled, states, "task_z", "PASS", null)).toBeNull();
	});
});

/**
 * `lane history` prints what `parseLog` returns, so a field the parser drops is a disclosure nobody
 * can read back — which is the whole job of `deferred` (#7041).
 */
describe("the deferral a proven PASS carries (#7041)", () => {
	const line = (fields: string) => `{"task":"issue","event":"ISSUE.PASS","at":"t"${fields}}\n`;

	it("carries the deferred namespaces back off the line, and refuses a shape that is not a list", () => {
		expect(parseLog(line(`,"deferred":["review-ui"]`))).toEqual({
			_tag: "Parsed",
			entries: [{task: "issue", event: "ISSUE.PASS", at: "t", deferred: ["review-ui"]}],
		});
		expect(parseLog(line(`,"deferred":"review-ui"`))).toMatchObject({_tag: "Malformed"});
		expect(parseLog(line(`,"deferred":[""]`))).toMatchObject({_tag: "Malformed"});
	});

	it("leaves a line that deferred nothing without the field", () => {
		expect(parseLog(line(""))).toEqual({
			_tag: "Parsed",
			entries: [{task: "issue", event: "ISSUE.PASS", at: "t"}],
		});
	});
});

/**
 * The routing payload a ship's `DONE` carries (ADR 0343). Absent reads as a closing merge, so the
 * whole ledger written before the field existed folds byte-for-byte as it did.
 */
describe("the partial merge a ship DONE carries (#7382)", () => {
	const line = (fields: string) => `{"task":"issue","event":"ISSUE.DONE","at":"t"${fields}}\n`;

	it("carries the flag back off the line, and refuses a shape that is not a boolean", () => {
		expect(parseLog(line(`,"partial":true`))).toEqual({
			_tag: "Parsed",
			entries: [{task: "issue", event: "ISSUE.DONE", at: "t", partial: true}],
		});
		expect(parseLog(line(`,"partial":"yes"`))).toMatchObject({_tag: "Malformed"});
	});

	it("leaves a closing merge's line without the field", () => {
		expect(parseLog(line(""))).toEqual({
			_tag: "Parsed",
			entries: [{task: "issue", event: "ISSUE.DONE", at: "t"}],
		});
	});

	it("carries the merged PRs that `partial` was read off (#7457)", () => {
		expect(parseLog(line(`,"partial":false,"landed":[7329]`))).toEqual({
			_tag: "Parsed",
			entries: [{task: "issue", event: "ISSUE.DONE", at: "t", partial: false, landed: [7329]}],
		});
	});

	it("refuses a `landed` naming no merged PR, which would read as evidence and attest nothing", () => {
		expect(parseLog(line(`,"landed":[]`))).toMatchObject({_tag: "Malformed"});
		expect(parseLog(line(`,"landed":["7329"]`))).toMatchObject({_tag: "Malformed"});
		expect(parseLog(line(`,"landed":7329`))).toMatchObject({_tag: "Malformed"});
	});
});

describe("the park cause a BLOCKED carries (#6480)", () => {
	const caused = (task: string, event: string, cause: string): LogEntry => ({
		...entry(task, event),
		cause,
	});

	it("parses a cause off the line and refuses one that is not a string", () => {
		expect(parseLog(`{"task":"issue","event":"ISSUE.BLOCKED","at":"t","cause":"x"}\n`)).toEqual({
			_tag: "Parsed",
			entries: [{task: "issue", event: "ISSUE.BLOCKED", at: "t", cause: "x"}],
		});
		expect(parseLog(`{"task":"issue","event":"ISSUE.BLOCKED","at":"t","cause":7}\n`)).toMatchObject(
			{
				_tag: "Malformed",
			},
		);
	});

	it("stands the cause of a task's latest entry, per task", () => {
		expect(
			standingCauses([
				entry("issue_1", "WIP"),
				caused("issue_1", "BLOCKED", "worktree-holds-branch"),
				entry("issue_2", "WIP"),
			]),
		).toEqual({issue_1: "worktree-holds-branch"});
	});

	it("drops the cause once a later event supersedes it — an UNBLOCKED carries none", () => {
		expect(
			standingCauses([
				caused("issue", "BLOCKED", "worktree-holds-branch"),
				entry("issue", "UNBLOCKED"),
			]),
		).toEqual({});
	});

	it("hangs the standing cause on the task's own context, beside its retries", () => {
		const compiled = lane(coderWorkflow());
		const entries = [entry("issue", "WIP"), caused("issue", "BLOCKED", "worktree-holds-branch")];
		const folded = foldLog(compiled, entries);
		if (folded._tag !== "Folded") throw new Error(folded.defects.join("; "));

		const status = deriveStatus(compiled, folded.states, standingCauses(entries));

		expect(status.stateValue).toEqual({pipeline: {issue: "blocked"}});
		expect(status.context.issue).toMatchObject({retries: 0, cause: "worktree-holds-branch"});
	});

	it("folds a log written before the field existed with no cause key at all", () => {
		const compiled = lane(coderWorkflow());
		const entries = [entry("issue", "WIP"), entry("issue", "BLOCKED")];
		const folded = foldLog(compiled, entries);
		if (folded._tag !== "Folded") throw new Error(folded.defects.join("; "));

		const status = deriveStatus(compiled, folded.states, standingCauses(entries));

		expect(Object.hasOwn(status.context.issue as object, "cause")).toBe(false);
	});

	it("leaves a park's cause standing across a grant — CLEARED supersedes nothing", () => {
		const granted: LogEntry = {...entry("issue", CLEARED_EVENT), round: CAP_ROUND};

		expect(standingCauses([caused("issue", "BLOCKED", "worktree-holds-branch"), granted])).toEqual({
			issue: "worktree-holds-branch",
		});
	});
});

describe("the parse defects that keep a grant from folding as a silent no-op (ADR 0312)", () => {
	const line = (fields: string) =>
		`{"task":"issue","event":"ISSUE.${CLEARED_EVENT}","at":"t"${fields}}\n`;

	it("refuses a CLEARED carrying no round", () => {
		expect(parseLog(line(""))).toMatchObject({
			_tag: "Malformed",
			defects: [`line 1 is a ${CLEARED_EVENT} event carrying no \`round\``],
		});
	});

	it("refuses a round that is not an integer", () => {
		expect(parseLog(line(`,"round":3.5`))).toMatchObject({
			_tag: "Malformed",
			defects: ["line 1 carries a non-integer `round` field"],
		});
	});

	it("parses the well-formed grant both defects sit beside", () => {
		expect(parseLog(line(`,"round":3`))).toEqual({
			_tag: "Parsed",
			entries: [{task: "issue", event: `ISSUE.${CLEARED_EVENT}`, at: "t", round: 3}],
		});
	});

	/** The same failure mode on the wait axis: a grant of nothing raises the budget by nothing. */
	it("refuses a waitGrant that names no whole grant, and parses one that does (ADR 0313)", () => {
		const resume = (fields: string) =>
			`{"task":"issue","event":"ISSUE.UNBLOCKED","at":"t"${fields}}\n`;
		const defect = ["line 1 carries a `waitGrant` that names no whole grant of waits"];

		expect(parseLog(resume(`,"waitGrant":0`))).toMatchObject({_tag: "Malformed", defects: defect});
		expect(parseLog(resume(`,"waitGrant":1.5`))).toMatchObject({
			_tag: "Malformed",
			defects: defect,
		});
		expect(parseLog(resume(`,"waitGrant":"one"`))).toMatchObject({
			_tag: "Malformed",
			defects: defect,
		});
		expect(parseLog(resume(`,"waitGrant":1`))).toEqual({
			_tag: "Parsed",
			entries: [{task: "issue", event: "ISSUE.UNBLOCKED", at: "t", waitGrant: 1}],
		});
	});
});

/**
 * The wait axis's own unbudgeted resume (#6717). It cannot key on `errorFinals` the way the retry
 * axis does: `human:queue-stall` is a plain state carrying no `type: "final"`, so it structurally
 * cannot be in that set, and the refusal keys on the wait counter and `ship:queued`'s own park
 * pairing instead.
 */
describe("the queue stall — a resume out of it needs the waits granted on the same line", () => {
	const stalled = () => {
		const compiled = lane(coderWorkflow());
		const dwell: ReadonlyArray<readonly [string, string]> = Array.from(
			{length: WAIT_BUDGET + 2},
			() => ["issue", "WIP"] as const,
		);
		const log = drive(compiled, [["issue", "WIP"], ["issue", "DONE"], ["issue", "PASS"], ...dwell]);
		const states = statesOf(compiled, log);
		expect(states.issue).toMatchObject({type: "human:queue-stall", waits: WAIT_BUDGET});
		return {compiled, log, states};
	};

	it("refuses a bare UNBLOCKED with the log unappended, naming the grant route and not `build clear`", () => {
		const {compiled, states} = stalled();

		const applied = applyEvent(compiled, states, "issue", "UNBLOCKED", "2026-08-29T00:00:00.000Z");

		expect(applied).toMatchObject({_tag: "Refused", kind: "unbudgeted-resume"});
		const reason = applied._tag === "Refused" ? applied.reason : "";
		expect(reason).toMatch(/the state comes back and the wait budget does not/);
		expect(reason).toMatch(/recipe unpark/);
		expect(reason).not.toMatch(/Record the founder's cleared round first/);
	});

	it("applies the same UNBLOCKED when it carries the grant, resuming one read below the budget", () => {
		const {compiled, log, states} = stalled();

		const applied = applyEvent(
			compiled,
			states,
			"issue",
			"UNBLOCKED",
			"2026-08-29T00:00:00.000Z",
			null,
			1,
		);

		expect(applied).toMatchObject({_tag: "Applied", entry: {waitGrant: 1}});
		if (applied._tag !== "Applied") return;
		expect(statesOf(compiled, [...log, applied.entry]).issue).toMatchObject({
			type: "ship:queued",
			waits: WAIT_BUDGET,
			maxWaits: WAIT_BUDGET + 1,
		});
	});
});
