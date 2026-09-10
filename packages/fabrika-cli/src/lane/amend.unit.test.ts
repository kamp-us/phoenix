/** The amendment rule: what a re-derived machine may move, and what it may never drop. */
import {describe, expect, it} from "vitest";
import {judgeAmendment} from "./amend.ts";
import {emitMachine} from "./emit.ts";
import type {LogEntry} from "./fold.ts";
import {type CompiledLane, compileText} from "./machine.ts";

const links = (...numbers: ReadonlyArray<number>) =>
	numbers.map((number) => ({number, state: "open" as const, stateReason: null}));

const bodyOf = (...lines: ReadonlyArray<string>): string =>
	["## Dependencies", "", ...lines].join("\n");

const machineOf = (body: string, children: ReadonlyArray<number>): CompiledLane => {
	const emitted = emitMachine(900, body, links(...children));
	if (emitted._tag !== "Emitted") throw new Error(`fixture did not emit: ${emitted._tag}`);
	const compiled = compileText(emitted.text);
	if (compiled._tag !== "Compiled") throw new Error(`fixture did not compile`);
	return compiled.lane;
};

const line = (task: string, event: string, at: string): LogEntry => ({
	task,
	event: `${task.toUpperCase()}.${event}`,
	at,
});

const AT = (n: number): string => `2026-09-0${n}T00:00:00.000Z`;

const ONE_PHASE = bodyOf("- phase 1: #901, #902");
const TWO_PHASES = bodyOf("- phase 1: #901", "- phase 2: #902");

describe("judgeAmendment", () => {
	it("accepts a task the new topology adds — it boots queued and carries no history", () => {
		const current = machineOf(ONE_PHASE, [901, 902]);
		const candidate = machineOf(bodyOf("- phase 1: #901, #902, #903"), [901, 902, 903]);

		const verdict = judgeAmendment(current, candidate, [line("issue_901", "WIP", AT(1))]);

		expect(verdict).toMatchObject({_tag: "Amendable", added: ["issue_903"], dropped: []});
		expect(candidate.tasks.issue_903?.initial.type).toBe("queued");
	});

	it("accepts a not-started task re-sequenced into a later phase", () => {
		const current = machineOf(ONE_PHASE, [901, 902]);
		const candidate = machineOf(TWO_PHASES, [901, 902]);

		const verdict = judgeAmendment(current, candidate, [line("issue_901", "WIP", AT(1))]);

		expect(verdict).toMatchObject({_tag: "Amendable", added: [], dropped: []});
	});

	it("accepts dropping a task that never started", () => {
		const current = machineOf(ONE_PHASE, [901, 902]);
		const candidate = machineOf(bodyOf("- phase 1: #901"), [901, 902]);

		const verdict = judgeAmendment(current, candidate, [line("issue_901", "WIP", AT(1))]);

		expect(verdict).toMatchObject({_tag: "Amendable", dropped: ["issue_902"]});
	});

	it("refuses dropping a task the log records as landed, naming the final it landed in", () => {
		const current = machineOf(ONE_PHASE, [901, 902]);
		const candidate = machineOf(bodyOf("- phase 1: #901"), [901, 902]);
		const landed = [
			line("issue_902", "WIP", AT(1)),
			line("issue_902", "DONE", AT(2)),
			line("issue_902", "PASS", AT(3)),
			line("issue_902", "DONE", AT(4)),
		];

		const verdict = judgeAmendment(current, candidate, landed);

		expect(verdict).toEqual({
			_tag: "DropsLanded",
			landed: [{task: "issue_902", state: "landed"}],
		});
	});

	it("refuses dropping a task that carries history but has not landed", () => {
		const current = machineOf(ONE_PHASE, [901, 902]);
		const candidate = machineOf(bodyOf("- phase 1: #901"), [901, 902]);

		const verdict = judgeAmendment(current, candidate, [line("issue_902", "WIP", AT(1))]);

		expect(verdict._tag).toBe("Unreachable");
		expect(verdict).toMatchObject({
			reasons: [
				'task "issue_902" carries recorded history and the new topology places it in no phase',
			],
		});
	});

	it("refuses a re-derived machine whose region cannot replay a task's recorded log", () => {
		const current = machineOf(ONE_PHASE, [901, 902]);
		// The board closed the second child as completed since emission, so its region now BOOTS in
		// `landed` — a final holding no `WIP` cell, which is the leaf its own recorded log cannot reach.
		const emitted = emitMachine(900, ONE_PHASE, [
			{number: 901, state: "open", stateReason: null},
			{number: 902, state: "closed", stateReason: "completed"},
		]);
		if (emitted._tag !== "Emitted") throw new Error("fixture did not emit");
		const compiled = compileText(emitted.text);
		if (compiled._tag !== "Compiled") throw new Error("fixture did not compile");

		const verdict = judgeAmendment(current, compiled.lane, [line("issue_902", "WIP", AT(1))]);

		expect(verdict._tag).toBe("Unreachable");
		expect((verdict as {reasons: ReadonlyArray<string>}).reasons.join(" ")).toContain("issue_902");
	});

	it("refuses a lane whose own log already does not replay through the machine it runs", () => {
		const current = machineOf(ONE_PHASE, [901, 902]);
		const candidate = machineOf(bodyOf("- phase 1: #901, #902, #903"), [901, 902, 903]);

		const verdict = judgeAmendment(current, candidate, [line("issue_901", "PASS", AT(1))]);

		expect(verdict._tag).toBe("Unreplayable");
	});
});

describe("judgeAmendment with a named deferral", () => {
	it("admits a historied drop the amendment names, which is otherwise refused", () => {
		const current = machineOf(ONE_PHASE, [901, 902]);
		const candidate = machineOf(bodyOf("- phase 1: #901"), [901, 902]);
		const log = [line("issue_901", "WIP", AT(1)), line("issue_902", "BLOCKED", AT(2))];

		expect(judgeAmendment(current, candidate, log)).toMatchObject({_tag: "Unreachable"});
		expect(judgeAmendment(current, candidate, log, ["issue_902"])).toMatchObject({
			_tag: "Amendable",
			dropped: ["issue_902"],
			deferred: ["issue_902"],
		});
	});

	it("leaves every other historied drop refused — naming one task admits one task", () => {
		const current = machineOf(bodyOf("- phase 1: #901, #902, #903"), [901, 902, 903]);
		const candidate = machineOf(bodyOf("- phase 1: #901"), [901, 902, 903]);
		const log = [line("issue_902", "BLOCKED", AT(1)), line("issue_903", "BLOCKED", AT(2))];

		const verdict = judgeAmendment(current, candidate, log, ["issue_902"]);

		expect(verdict).toMatchObject({_tag: "Unreachable"});
		expect(verdict._tag === "Unreachable" && verdict.reasons).toEqual([
			'task "issue_903" carries recorded history and the new topology places it in no phase',
		]);
	});

	it("still refuses a deferred task the ledger proves landed — the landing rule reaches first", () => {
		const current = machineOf(ONE_PHASE, [901, 902]);
		const candidate = machineOf(bodyOf("- phase 1: #901"), [901, 902]);
		const log = [
			line("issue_902", "WIP", AT(1)),
			line("issue_902", "DONE", AT(2)),
			line("issue_902", "PASS", AT(3)),
			line("issue_902", "DONE", AT(4)),
		];

		expect(judgeAmendment(current, candidate, log, ["issue_902"])).toMatchObject({
			_tag: "DropsLanded",
		});
	});

	it("refuses a deferral naming a task this machine never held", () => {
		const current = machineOf(ONE_PHASE, [901, 902]);
		const candidate = machineOf(bodyOf("- phase 1: #901"), [901, 902]);

		const verdict = judgeAmendment(
			current,
			candidate,
			[line("issue_901", "WIP", AT(1))],
			["issue_999"],
		);

		expect(verdict).toMatchObject({_tag: "DeferralRefused"});
		expect(verdict._tag === "DeferralRefused" && verdict.reasons[0]).toContain(
			"this lane's machine holds no such task",
		);
	});

	it("refuses a deferral the new topology still places", () => {
		const current = machineOf(ONE_PHASE, [901, 902]);
		const candidate = machineOf(TWO_PHASES, [901, 902]);

		const verdict = judgeAmendment(
			current,
			candidate,
			[line("issue_902", "WIP", AT(1))],
			["issue_902"],
		);

		expect(verdict).toMatchObject({_tag: "DeferralRefused"});
		expect(verdict._tag === "DeferralRefused" && verdict.reasons[0]).toContain(
			"still places it in a phase",
		);
	});

	it("refuses a deferral of a task with no history — the ordinary amendment already drops it", () => {
		const current = machineOf(ONE_PHASE, [901, 902]);
		const candidate = machineOf(bodyOf("- phase 1: #901"), [901, 902]);

		const verdict = judgeAmendment(
			current,
			candidate,
			[line("issue_901", "WIP", AT(1))],
			["issue_902"],
		);

		expect(verdict).toMatchObject({_tag: "DeferralRefused"});
		expect(verdict._tag === "DeferralRefused" && verdict.reasons[0]).toContain(
			"carries no recorded history",
		);
	});

	it("keeps every surviving task's leaf where it stood", () => {
		const current = machineOf(bodyOf("- phase 1: #901, #902"), [901, 902]);
		const candidate = machineOf(bodyOf("- phase 1: #901"), [901, 902]);
		const log = [line("issue_901", "WIP", AT(1)), line("issue_902", "BLOCKED", AT(2))];

		const verdict = judgeAmendment(current, candidate, log, ["issue_902"]);

		expect(verdict).toMatchObject({_tag: "Amendable", tasks: ["issue_901", "epic_900"]});
	});
});
