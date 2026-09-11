/**
 * `resolveDeferrals` — the bound that keeps a deferred task's history accounted for, and the four
 * shapes that leave it unaccountable.
 */
import {describe, expect, it} from "vitest";
import {resolveDeferrals} from "./deferral.ts";
import type {LogEntry} from "./fold.ts";

const at = (n: number): string => `2026-09-0${n}T00:00:00.000Z`;

const event = (task: string, name: string, when: string): LogEntry => ({
	task,
	event: `${task.toUpperCase()}.${name}`,
	at: when,
});

const amendment = (
	when: string,
	defers: ReadonlyArray<{task: string; through: string; reason: string}>,
): LogEntry => ({
	task: "epic_1",
	event: "EPIC_1.AMENDED",
	at: when,
	tasks: ["issue_2", "epic_1"],
	defers,
});

const REASON = "founder deferred it to a follow-up cycle";

describe("resolveDeferrals", () => {
	it("answers nothing on a log holding no amendment", () => {
		expect(resolveDeferrals([event("issue_2", "WIP", at(1))])).toEqual({
			_tag: "Resolved",
			deferrals: [],
		});
	});

	it("resolves a deferral bounded at the task's last recorded entry", () => {
		const resolved = resolveDeferrals([
			event("issue_2", "WIP", at(1)),
			event("issue_3", "BLOCKED", at(2)),
			amendment(at(3), [{task: "issue_3", through: at(2), reason: REASON}]),
		]);

		expect(resolved).toEqual({
			_tag: "Resolved",
			deferrals: [{task: "issue_3", through: at(2), reason: REASON, at: at(3)}],
		});
	});

	it("refuses a bound naming no event of that task", () => {
		const resolved = resolveDeferrals([
			event("issue_3", "BLOCKED", at(2)),
			amendment(at(3), [{task: "issue_3", through: at(1), reason: REASON}]),
		]);

		expect(resolved._tag).toBe("Undecidable");
		expect(resolved._tag === "Undecidable" && resolved.defects[0]).toContain(
			"names no recorded event of that task",
		);
	});

	it("refuses a bound naming more than one event of that task", () => {
		const resolved = resolveDeferrals([
			event("issue_3", "WIP", at(2)),
			event("issue_3", "BLOCKED", at(2)),
			amendment(at(3), [{task: "issue_3", through: at(2), reason: REASON}]),
		]);

		expect(resolved._tag).toBe("Undecidable");
		expect(resolved._tag === "Undecidable" && resolved.defects[0]).toContain(
			"names 2 recorded event of that task",
		);
	});

	it("refuses a bound the task recorded past before the amendment landed", () => {
		const resolved = resolveDeferrals([
			event("issue_3", "WIP", at(1)),
			event("issue_3", "BLOCKED", at(2)),
			amendment(at(3), [{task: "issue_3", through: at(1), reason: REASON}]),
		]);

		expect(resolved._tag).toBe("Undecidable");
		expect(resolved._tag === "Undecidable" && resolved.defects[0]).toContain(
			"the log records 1 later event(s) of that task: BLOCKED",
		);
	});

	it("refuses a task reintroduced after the deferral — never silently ignores it", () => {
		const resolved = resolveDeferrals([
			event("issue_3", "BLOCKED", at(2)),
			amendment(at(3), [{task: "issue_3", through: at(2), reason: REASON}]),
			event("issue_3", "UNBLOCKED", at(4)),
		]);

		expect(resolved._tag).toBe("Undecidable");
		expect(resolved._tag === "Undecidable" && resolved.defects[0]).toContain(
			"later event(s) of that task: UNBLOCKED",
		);
	});

	it("refuses one task deferred by two amendments", () => {
		const resolved = resolveDeferrals([
			event("issue_3", "BLOCKED", at(2)),
			amendment(at(3), [{task: "issue_3", through: at(2), reason: REASON}]),
			amendment(at(4), [{task: "issue_3", through: at(2), reason: REASON}]),
		]);

		expect(resolved._tag).toBe("Undecidable");
		expect(resolved._tag === "Undecidable" && resolved.defects[0]).toContain(
			"which an earlier amendment already deferred",
		);
	});
});
