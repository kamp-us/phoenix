import {describe, expect, it} from "vitest";
import {instant} from "../wire/lane-record.ts";
import {applyCorrections, parseLog} from "./fold.ts";
import {
	BASE_RED_CAUSE,
	integrateEvidenceRefusal,
	readIntegrateClaim,
	readIntegrateEvidence,
	resolveIntegrateClaim,
	standingIntegrateFailure,
} from "./integrate-failure.ts";
import type {IntegrateRedRecord} from "./integrate-red.ts";

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
	const evidence = {_tag: "Fail", failure: {exit: 44, head: HEAD}} as const;
	const baseRed = {_tag: "BaseRed", head: HEAD} as const;

	it("requires the evidence on a FAIL out of integrate and admits it there", () => {
		expect(integrateEvidenceRefusal("integrate", "FAIL", null, null)).toContain("--integrate-exit");
		expect(integrateEvidenceRefusal("integrate", "FAIL", null, evidence)).toBeNull();
	});

	it("refuses it on every other line, and asks nothing of lines without it", () => {
		expect(integrateEvidenceRefusal("review", "FAIL", null, evidence)).toContain('out of "review"');
		expect(integrateEvidenceRefusal("integrate", "DONE", null, evidence)).not.toBeNull();
		expect(integrateEvidenceRefusal("review", "FAIL", null, null)).toBeNull();
		expect(integrateEvidenceRefusal("integrate", "DONE", null, null)).toBeNull();
	});

	it("admits the red-base exit on the red-base lap and its park out of integrate, and nowhere else", () => {
		expect(integrateEvidenceRefusal("integrate", "LAP", BASE_RED_CAUSE, baseRed)).toBeNull();
		expect(integrateEvidenceRefusal("integrate", "BLOCKED", BASE_RED_CAUSE, baseRed)).toBeNull();
		expect(integrateEvidenceRefusal("review", "LAP", BASE_RED_CAUSE, baseRed)).toContain(
			'out of "integrate" only',
		);
		expect(integrateEvidenceRefusal("integrate", "FAIL", null, baseRed)).toContain("BASE-RED");
		expect(integrateEvidenceRefusal("integrate", "LAP", "spawn-dead", baseRed)).not.toBeNull();
	});

	it("refuses the red-base cause typed without the exit integrate printed", () => {
		expect(integrateEvidenceRefusal("integrate", "LAP", BASE_RED_CAUSE, null)).toContain(
			"--integrate-exit 75",
		);
		expect(integrateEvidenceRefusal("integrate", "BLOCKED", BASE_RED_CAUSE, evidence)).toContain(
			"--integrate-exit 75",
		);
	});
});

describe("readIntegrateClaim", () => {
	it("reads a FAIL exit as a FAIL and the red-base exit as a red base", () => {
		expect(readIntegrateClaim(44, HEAD)).toEqual({
			_tag: "Read",
			claim: {_tag: "Fail", failure: {exit: 44, head: HEAD}},
		});
		expect(readIntegrateClaim(75, HEAD)).toEqual({
			_tag: "Read",
			claim: {_tag: "BaseRed", head: HEAD},
		});
	});

	it("refuses any other exit, and the attach reader still refuses the red-base exit", () => {
		expect(readIntegrateClaim(45, HEAD)._tag).toBe("Rejected");
		expect(readIntegrateEvidence(75, HEAD)._tag).toBe("Rejected");
	});
});

describe("resolveIntegrateClaim — the record decides whose red it is", () => {
	const output = (text: string) => ({
		stdout: {lines: [text], omitted: 0},
		stderr: {lines: [], omitted: 0},
	});
	const at = instant("2026-10-04T00:00:00.000Z");
	if (at === null) throw new Error("the fixture instant does not parse");
	const record = (
		base: IntegrateRedRecord["base"],
		child = "build/5828-a-1234abcd",
	): IntegrateRedRecord => ({
		at,
		child,
		head: HEAD,
		merged: {validator: "pnpm test", output: output("merged red")},
		base,
	});
	const green = record({verdict: "green"});
	const red = record({verdict: "red", output: output("base red")});
	const fail44 = {_tag: "Fail", failure: {exit: 44, head: HEAD.slice(0, 7)}} as const;
	const baseRed = {_tag: "BaseRed", head: HEAD.slice(0, 7)} as const;

	it("lands a 44 over a green base, carrying the merged run's validator and output", () => {
		expect(resolveIntegrateClaim(fail44, [green], 5828)).toEqual({
			_tag: "Failure",
			failure: {exit: 44, head: HEAD.slice(0, 7), red: green.merged},
		});
	});

	it("refuses a 44 over a red base, and a red base over a green one", () => {
		expect(resolveIntegrateClaim(fail44, [red], 5828)).toMatchObject({_tag: "Refused"});
		expect(resolveIntegrateClaim(baseRed, [green], 5828)).toMatchObject({_tag: "Refused"});
	});

	it("lands a red base carrying the base run's output", () => {
		expect(resolveIntegrateClaim(baseRed, [red], 5828)).toEqual({
			_tag: "BaseRed",
			baseRed: {
				head: HEAD.slice(0, 7),
				red: {validator: "pnpm test", output: output("base red")},
			},
		});
	});

	it("refuses with no record for this child, and reads the latest one that is", () => {
		expect(resolveIntegrateClaim(baseRed, [], 5828)).toMatchObject({_tag: "Refused"});
		expect(
			resolveIntegrateClaim(
				baseRed,
				[record({verdict: "red", output: output("x")}, "build/9-b-1234abcd")],
				5828,
			),
		).toMatchObject({_tag: "Refused"});
		expect(resolveIntegrateClaim(baseRed, [green, red], 5828)._tag).toBe("BaseRed");
	});

	it("takes a 42 or a 43 off the pair alone", () => {
		const fail43 = {_tag: "Fail", failure: {exit: 43, head: HEAD}} as const;
		expect(resolveIntegrateClaim(fail43, [], null)).toEqual({
			_tag: "Failure",
			failure: {exit: 43, head: HEAD},
		});
	});
});

describe("parseLog — the integrate field", () => {
	const text = (...records: ReadonlyArray<unknown>) =>
		records.map((record) => JSON.stringify(record)).join("\n");

	it("carries a well-formed integrate FAIL through", () => {
		const parsed = parseLog(text(failed(42)));
		expect(parsed).toMatchObject({_tag: "Parsed", entries: [{integrate: {exit: 42, head: HEAD}}]});
	});

	it("carries a 44's validator and output through, and refuses them on a 42", () => {
		const red = {
			validator: "pnpm test",
			output: {stdout: {lines: ["FAIL a.test.ts"], omitted: 3}, stderr: {lines: [], omitted: 0}},
		};
		expect(parseLog(text(line("FAIL", {integrate: {exit: 44, head: HEAD, red}})))).toMatchObject({
			_tag: "Parsed",
			entries: [{integrate: {exit: 44, red}}],
		});
		expect(parseLog(text(line("FAIL", {integrate: {exit: 42, head: HEAD, red}})))._tag).toBe(
			"Malformed",
		);
	});

	it("carries a red base's evidence on its own cause only", () => {
		const baseRed = {
			head: HEAD,
			red: {
				validator: "pnpm test",
				output: {stdout: {lines: [], omitted: 0}, stderr: {lines: ["boom"], omitted: 0}},
			},
		};
		expect(parseLog(text(line("LAP", {cause: BASE_RED_CAUSE, baseRed})))).toMatchObject({
			_tag: "Parsed",
			entries: [{baseRed}],
		});
		expect(parseLog(text(line("LAP", {cause: "spawn-dead", baseRed})))._tag).toBe("Malformed");
		expect(parseLog(text(line("LAP", {cause: BASE_RED_CAUSE, baseRed: {head: HEAD}})))._tag).toBe(
			"Malformed",
		);
	});

	it("refuses a malformed record and one riding any event but FAIL", () => {
		expect(parseLog(text(failed(45)))._tag).toBe("Malformed");
		expect(parseLog(text(line("DONE", {integrate: {exit: 44, head: HEAD}})))._tag).toBe(
			"Malformed",
		);
	});
});

describe("a CORRECTED line attaching the pair to a FAIL recorded without it", () => {
	const text = (...records: ReadonlyArray<unknown>) =>
		records.map((record) => JSON.stringify(record)).join("\n");
	const FAILED_AT = "2026-09-20T18:03:00.000Z";
	const pairless = {...line("FAIL"), at: FAILED_AT};
	const attach = (extra: Record<string, unknown> = {}) => ({
		...line("CORRECTED", {corrects: FAILED_AT, integrate: {exit: 43, head: HEAD}, ...extra}),
		at: "2026-09-27T03:00:00.000Z",
	});

	it("parses, and resolves into the FAIL it names", () => {
		const parsed = parseLog(text(line("PASS"), pairless, attach()));
		if (parsed._tag !== "Parsed") throw new Error(parsed.defects.join("; "));
		const resolved = applyCorrections(parsed.entries);
		expect(resolved).toMatchObject({
			_tag: "Corrected",
			entries: [{event: "ISSUE_5828.PASS"}, {at: FAILED_AT, integrate: {exit: 43, head: HEAD}}],
		});
		if (resolved._tag !== "Corrected") return;
		expect(standingIntegrateFailure(resolved.entries, TASK)).toEqual({exit: 43, head: HEAD});
	});

	it("refuses a correction carrying both payloads, or neither", () => {
		expect(parseLog(text(pairless, attach({partial: true})))._tag).toBe("Malformed");
		expect(
			parseLog(text(pairless, {...line("CORRECTED", {corrects: FAILED_AT}), at: "x"}))._tag,
		).toBe("Malformed");
	});

	it("will not resolve the pair onto an event that is not a FAIL", () => {
		const parsed = parseLog(text({...line("PASS"), at: FAILED_AT}, attach()));
		if (parsed._tag !== "Parsed") throw new Error(parsed.defects.join("; "));
		expect(applyCorrections(parsed.entries)._tag).toBe("Undecidable");
	});
});
