import {describe, expect, it} from "vitest";
import {parseLog} from "./fold.ts";
import {
	integrateEvidenceRefusal,
	readIntegrateEvidence,
	standingIntegrateFailure,
} from "./integrate-failure.ts";

const HEAD = "9f2c1ab4d5e6f708192a3b4c5d6e7f8091a2b3c4";
const TASK = "issue_5828";
const line = (event: string, extra: Record<string, unknown> = {}, task = TASK) =>
	({
		task,
		event: `${task.toUpperCase()}.${event}`,
		at: "2026-09-26T00:00:00.000Z",
		...extra,
	}) as const;
const failed = (exit: number, head = HEAD) => line("FAIL", {integrate: {exit, head}});

describe("standingIntegrateFailure", () => {
	it("answers the integrate FAIL a PASS-graded child was sent back on", () => {
		const entries = [line("WIP"), line("DONE"), line("PASS"), failed(44)];
		expect(standingIntegrateFailure(entries, TASK)).toEqual({exit: 44, head: HEAD});
	});

	it("answers null where no integrate FAIL was ever recorded", () => {
		const entries = [line("WIP"), line("DONE"), line("PASS"), line("FAIL")];
		expect(standingIntegrateFailure(entries, TASK)).toBeNull();
	});

	it("retires a FAIL the task answered with a later DONE", () => {
		const entries = [line("WIP"), line("DONE"), line("PASS"), failed(43), line("DONE")];
		expect(standingIntegrateFailure(entries, TASK)).toBeNull();
	});

	it("keeps it standing across a park and its clear — the repair is still owed", () => {
		const entries = [failed(42), line("BLOCKED", {cause: "tree-hijacked"}), line("UNBLOCKED")];
		expect(standingIntegrateFailure(entries, TASK)).toEqual({exit: 42, head: HEAD});
	});

	it("reads only this task's lines", () => {
		const entries = [failed(44, HEAD), line("DONE", {}, "issue_9999")];
		expect(standingIntegrateFailure(entries, TASK)).toEqual({exit: 44, head: HEAD});
		expect(standingIntegrateFailure(entries, "issue_9999")).toBeNull();
	});
});

describe("readIntegrateEvidence", () => {
	it("reads both flags as one record and lower-cases the sha", () => {
		expect(readIntegrateEvidence(43, HEAD.toUpperCase())).toEqual({
			_tag: "Read",
			failure: {exit: 43, head: HEAD},
		});
	});

	it("reads neither as none, and refuses either one alone", () => {
		expect(readIntegrateEvidence(null, null)).toEqual({_tag: "None"});
		expect(readIntegrateEvidence(44, null)._tag).toBe("Rejected");
		expect(readIntegrateEvidence(null, HEAD)._tag).toBe("Rejected");
	});

	it("refuses an exit integrate does not FAIL on, and a head that is no sha", () => {
		expect(readIntegrateEvidence(45, HEAD)._tag).toBe("Rejected");
		expect(readIntegrateEvidence(44, "epic/900")._tag).toBe("Rejected");
	});
});

describe("integrateEvidenceRefusal", () => {
	const evidence = {exit: 44, head: HEAD} as const;

	it("requires the evidence on a FAIL out of integrate and admits it there", () => {
		expect(integrateEvidenceRefusal("integrate", "FAIL", null)).toContain("--integrate-exit");
		expect(integrateEvidenceRefusal("integrate", "FAIL", evidence)).toBeNull();
	});

	it("refuses it on every other line, and asks nothing of lines without it", () => {
		expect(integrateEvidenceRefusal("review", "FAIL", evidence)).toContain('out of "review"');
		expect(integrateEvidenceRefusal("integrate", "DONE", evidence)).not.toBeNull();
		expect(integrateEvidenceRefusal("review", "FAIL", null)).toBeNull();
		expect(integrateEvidenceRefusal("integrate", "DONE", null)).toBeNull();
	});
});

describe("parseLog — the integrate field", () => {
	const text = (...records: ReadonlyArray<unknown>) =>
		records.map((record) => JSON.stringify(record)).join("\n");

	it("carries a well-formed integrate FAIL through", () => {
		const parsed = parseLog(text(failed(42)));
		expect(parsed).toMatchObject({_tag: "Parsed", entries: [{integrate: {exit: 42, head: HEAD}}]});
	});

	it("refuses a malformed record and one riding any event but FAIL", () => {
		expect(parseLog(text(failed(45)))._tag).toBe("Malformed");
		expect(parseLog(text(line("DONE", {integrate: {exit: 44, head: HEAD}})))._tag).toBe(
			"Malformed",
		);
	});
});
