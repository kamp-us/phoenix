/**
 * The eval record's own tier: the outcome token, the head binding, and the aggregates the read
 * re-derives instead of trusting.
 *
 * The assertions that carry the design are the refusals. Each one feeds bytes a lenient reader would
 * answer `Found` for — a gate polarity where the outcome belongs, a payload bound to a different
 * head, a `dispersion` its own run counts contradict — because the failure this module removes is
 * not a crash, it is a *plausible* measurement.
 */
import {describe, expect, it} from "vitest";
import {
	dispersionOf,
	type EvalRecord,
	emit,
	emitFromFields,
	read,
	readToLines,
	recordedAt,
	renderRecord,
	roundRate,
} from "./eval-record.ts";
import {bindToHead, clause, headSha, type VerdictMarker} from "./verdict-marker.ts";

const HEAD = "03135b91e7d4a2c6f1b8093a5c4d2e1f6a7b8c9d";

const sha = (raw: string) => {
	const value = headSha(raw);
	if (value === null) throw new Error(`fixture is not a head SHA: ${raw}`);
	return value;
};
const text = (raw: string) => {
	const value = clause(raw);
	if (value === null) throw new Error("fixture clause is blank");
	return value;
};
const at = (raw: string) => {
	const value = recordedAt(raw);
	if (value === null) throw new Error(`fixture is not an instant: ${raw}`);
	return value;
};

const RECORD: EvalRecord = {
	outcome: "RECORDED",
	sha: sha(HEAD),
	clause: text("review/skill 0.5 (1/2 cases, 0 unmeasured)"),
	payload: {
		sha: sha(HEAD),
		recordedAt: at("2026-08-10T04:08:00Z"),
		cell: {stage: "review", surface: "skill", model: "claude-opus-4-6"},
		pins: {model: "claude-opus-4-6", cli: "2.1.220", harness: "fabrika 0.1.0"},
		gradedRuns: 2,
		passedRuns: 1,
		unmeasuredCases: 0,
		passRate: 0.5,
		cases: [
			{
				caseId: 11,
				verdict: "pass",
				runs: 5,
				passed: 3,
				noVerdict: 1,
				dispersion: 2,
				perRun: ["pass", "fail", "pass", "no-verdict:timed-out", "pass"],
			},
			{
				caseId: 12,
				verdict: "fail",
				runs: 5,
				passed: 0,
				noVerdict: 0,
				dispersion: 0,
				perRun: ["fail", "fail", "fail", "fail", "fail"],
			},
		],
	},
};

const refusal = (artifact: string): {tag: string; reason: string} => {
	const result = read(artifact);
	return {tag: result._tag, reason: result._tag === "Found" ? "" : result.reason};
};

const withPayload = (payload: unknown, marker = `eval: RECORDED @ ${HEAD} — a clause`): string =>
	`${marker}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`;

/** One passing and one failing case — the honest cell aggregate is `1/2 = 0.5`, 0 unmeasured. */
const TWO_CASES = [
	{
		caseId: 1,
		verdict: "pass",
		runs: 5,
		passed: 4,
		noVerdict: 0,
		dispersion: 1,
		perRun: ["pass", "pass", "fail", "pass", "pass"],
	},
	{
		caseId: 2,
		verdict: "fail",
		runs: 5,
		passed: 0,
		noVerdict: 0,
		dispersion: 0,
		perRun: ["fail", "fail", "fail", "fail", "fail"],
	},
];

const payloadOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	sha: HEAD,
	recordedAt: "2026-08-10T04:08:00Z",
	cell: {stage: "review", surface: "skill", model: "m"},
	pins: {model: "m", cli: "c", harness: "h"},
	gradedRuns: 1,
	passedRuns: 1,
	unmeasuredCases: 0,
	passRate: 1,
	cases: [
		{
			caseId: 1,
			verdict: "pass",
			runs: 5,
			passed: 4,
			noVerdict: 0,
			dispersion: 1,
			perRun: ["pass", "pass", "fail", "pass", "pass"],
		},
	],
	...over,
});

describe("the record round-trips", () => {
	it("emits a marker line the read answers Found on, with the payload intact", () => {
		const result = read(emit(RECORD));
		expect(result._tag).toBe("Found");
		if (result._tag !== "Found") return;
		expect(result.value).toEqual(RECORD);
	});

	it("survives the fields adapter the registry row calls", () => {
		const composed = emitFromFields(
			[
				"outcome: RECORDED",
				`sha: ${HEAD}`,
				"clause: review/skill 0.5 (1/2 cases, 0 unmeasured)",
				"payload:",
				JSON.stringify(RECORD.payload),
			].join("\n"),
		);
		expect(composed._tag).toBe("Composed");
		if (composed._tag !== "Composed") return;
		expect(readToLines(composed.bytes)).toEqual({_tag: "Found", value: renderRecord(RECORD)});
	});
});

describe("bytes that are not a record read Absent, never Malformed", () => {
	it.each([
		["empty bytes", ""],
		["an ordinary comment", "Looks good to me, shipping it.\n"],
		["a gate verdict in its own namespace", `review-skill: PASS @ ${HEAD} — merge-ready\n`],
	])("%s", (_case, artifact) => {
		expect(read(artifact)._tag).toBe("Absent");
	});
});

describe("a record that drifted is Malformed — never a measurement nobody took", () => {
	it("refuses a gate polarity where the outcome token belongs", () => {
		const {tag, reason} = refusal(`eval: PASS @ ${HEAD} — a clause\n`);
		expect(tag).toBe("Malformed");
		expect(reason).toContain("RECORDED");
	});

	it("refuses a record bound to no head", () => {
		expect(refusal("eval: RECORDED — a clause\n").tag).toBe("Malformed");
	});

	it("refuses a payload bound to a different head than the marker", () => {
		const {tag, reason} = refusal(withPayload(payloadOf({sha: "aaaaaaa"})));
		expect(tag).toBe("Malformed");
		expect(reason).toContain("one record, one head");
	});

	it("refuses a dispersion its own run counts contradict", () => {
		const {tag, reason} = refusal(
			withPayload(
				payloadOf({
					cases: [
						{
							caseId: 1,
							verdict: "pass",
							runs: 5,
							passed: 4,
							noVerdict: 0,
							dispersion: 0,
							perRun: ["pass", "pass", "fail", "pass", "pass"],
						},
					],
				}),
			),
		);
		expect(tag).toBe("Malformed");
		expect(reason).toContain("dispersion");
	});

	it("refuses a pass rate its own denominator contradicts", () => {
		const {tag, reason} = refusal(
			withPayload(payloadOf({gradedRuns: 2, passedRuns: 1, passRate: 1, cases: TWO_CASES})),
		);
		expect(tag).toBe("Malformed");
		expect(reason).toContain("passRate");
	});

	// The cell half of the re-derivation promise. Both of these read back `Found` before the fix that
	// added it, publishing a figure the record's own case blocks contradict (review-code on #5401).
	it("refuses a cell aggregate its own case blocks contradict", () => {
		const {tag, reason} = refusal(
			withPayload(payloadOf({gradedRuns: 10, passedRuns: 10, passRate: 1, cases: TWO_CASES})),
		);
		expect(tag).toBe("Malformed");
		expect(reason).toContain("gradedRuns");
	});

	it("refuses graded cases claimed over an empty cases array", () => {
		const {tag, reason} = refusal(
			withPayload(payloadOf({gradedRuns: 10, passedRuns: 10, passRate: 1, cases: []})),
		);
		expect(tag).toBe("Malformed");
		expect(reason).toContain("0 graded case(s)");
	});

	it("refuses an unmeasuredCases count the case blocks contradict", () => {
		const {tag, reason} = refusal(
			withPayload(
				payloadOf({
					gradedRuns: 2,
					passedRuns: 1,
					passRate: 0.5,
					unmeasuredCases: 1,
					cases: TWO_CASES,
				}),
			),
		);
		expect(tag).toBe("Malformed");
		expect(reason).toContain("unmeasuredCases");
	});

	it("refuses a case whose passed and no-verdict counts exceed its runs", () => {
		const {tag} = refusal(
			withPayload(
				payloadOf({
					cases: [
						{
							caseId: 1,
							verdict: "pass",
							runs: 5,
							passed: 4,
							noVerdict: 3,
							dispersion: 1,
							perRun: ["pass", "pass", "fail", "pass", "pass"],
						},
					],
				}),
			),
		);
		expect(tag).toBe("Malformed");
	});

	it("refuses a record with no pins — the model/CLI/harness triple is required", () => {
		const {tag, reason} = refusal(withPayload(payloadOf({pins: {model: "m", cli: "c"}})));
		expect(tag).toBe("Malformed");
		expect(reason).toContain("pins");
	});

	it("refuses a namespace that reaches for eval and is not the eval root", () => {
		expect(refusal(`eval-skill: RECORDED @ ${HEAD} — a clause\n`).tag).toBe("Malformed");
	});
});

describe("RECORDED and UNRECORDABLE are about whether a measurement exists", () => {
	it("refuses RECORDED over zero graded runs — that is a green over nothing", () => {
		const {tag, reason} = refusal(
			withPayload(payloadOf({gradedRuns: 0, passedRuns: 0, passRate: 0, cases: []})),
		);
		expect(tag).toBe("Malformed");
		expect(reason).toContain("measures nothing");
	});

	it("accepts UNRECORDABLE over zero graded runs, with its case blocks retained", () => {
		const result = read(
			withPayload(
				payloadOf({
					gradedRuns: 0,
					passedRuns: 0,
					unmeasuredCases: 1,
					passRate: 0,
					cases: [
						{
							caseId: 1,
							verdict: "unmeasured",
							runs: 5,
							passed: 0,
							noVerdict: 5,
							dispersion: 0,
							perRun: [
								"no-verdict:timed-out",
								"no-verdict:timed-out",
								"no-verdict:no-output",
								"no-verdict:unparseable",
								"no-verdict:invocation-failed",
							],
						},
					],
				}),
				`eval: UNRECORDABLE @ ${HEAD} — nothing measured`,
			),
		);
		expect(result._tag).toBe("Found");
		if (result._tag !== "Found") return;
		expect(result.value.outcome).toBe("UNRECORDABLE");
		expect(result.value.payload.cases[0]?.noVerdict).toBe(5);
	});

	it("accepts a below-bar rate — the bar belongs to the merge gate, not the record", () => {
		const result = read(
			withPayload(payloadOf({gradedRuns: 2, passedRuns: 1, passRate: 0.5, cases: TWO_CASES})),
		);
		expect(result._tag).toBe("Found");
	});
});

describe("the binding is the verdict marker's, reused", () => {
	it("answers Current for the head it was measured at and Stale for one that moved", () => {
		const found = read(emit(RECORD));
		if (found._tag !== "Found") throw new Error("fixture did not read back");
		const marker: VerdictMarker = {
			namespace: "eval",
			polarity: "PASS",
			sha: found.value.sha,
			clause: found.value.clause,
		};
		expect(bindToHead(marker, HEAD)._tag).toBe("Current");
		expect(bindToHead(marker, "b91e7d4a2c6f1b8093a5c4d2e1f6a7b8c9d03135")._tag).toBe("Stale");
		expect(bindToHead(marker, "not-a-sha")._tag).toBe("Unbindable");
	});
});

describe("the arithmetic the payload carries", () => {
	it("dispersion is the minority-verdict count over the runs (ADR 0252 §1)", () => {
		expect(dispersionOf(5, 5)).toBe(0);
		expect(dispersionOf(5, 4)).toBe(1);
		expect(dispersionOf(5, 3)).toBe(2);
		expect(dispersionOf(5, 0)).toBe(0);
	});

	it("rates are stored at four decimal places", () => {
		expect(roundRate(2 / 3)).toBe(0.6667);
		expect(roundRate(19 / 20)).toBe(0.95);
	});
});
