/**
 * The six-event contract, tested as the spike's recorded runs (#5671 run 8 and 19; the
 * state-ledger rebuild's runs 1–6 recorded on #5570's 2026-08-15 session note are the plan).
 */
import {describe, expect, it} from "vitest";
import {coderWorkflow, twoPhaseWorkflow} from "./fixtures.test-support.ts";
import {applyEvent, deriveStatus, foldLog, type LogEntry, parseLog, resolveTask} from "./fold.ts";
import {type CompiledLane, compile} from "./machine.ts";

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
const drive = (compiled: CompiledLane, steps: ReadonlyArray<readonly [string, string]>) => {
	const log: LogEntry[] = [];
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
				task_a: {retries: 0, maxRetries: 2, code: true},
				task_b: {retries: 0, maxRetries: 3, code: false},
				task_c: {retries: 0, maxRetries: 3, code: true},
				errors: [],
			},
		});
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
