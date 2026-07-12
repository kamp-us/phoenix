/**
 * Pure-core tests for `campaign verify-trace` (#2658) — the fail-closed founder-approval-trace
 * verifier. The whole security property is default-DENY: PASS requires positive evidence of a
 * present, well-formed, founder-authored, wave-bound marker, and every ambiguous/malformed/empty
 * input fails closed (ADR 0092). The four fail-closed paths the acceptance criteria enumerate —
 * absence, malformation, non-founder author, zero scope — are each covered exhaustively here. No
 * IO: the `gh api` boundary is exercised separately; this file feeds `verifyTrace` plain fixtures.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	type ApprovalComment,
	renderReport,
	type TraceVerdict,
	type VerifyTraceInput,
	verifyTrace,
} from "./campaign-trace.ts";

const FOUNDER = "founder-login";
const WAVE = "audit-wave-27";

const comment = (over: Partial<ApprovalComment>): ApprovalComment => ({
	id: 1,
	author: FOUNDER,
	createdAt: "2026-07-10T12:00:00Z",
	body: `campaign-approve: ${WAVE} · 2026-07-10T12:00:00Z`,
	issue: 100,
	...over,
});

const input = (over: Partial<VerifyTraceInput>): VerifyTraceInput => ({
	waveLabel: WAVE,
	founderLogin: FOUNDER,
	clusterSize: 3,
	comments: [],
	...over,
});

/** Narrow to a fail verdict so `reason`/`detail` are accessible without a `pass` re-check per assertion. */
const asFail = (v: TraceVerdict): Exclude<TraceVerdict, {pass: true}> => {
	if (v.pass) throw new Error("expected a FAIL verdict, got PASS");
	return v;
};

describe("verifyTrace — PASS only on a present, well-formed, founder-authored, wave-bound marker", () => {
	it("PASSES for a founder-authored marker that binds to the wave", () => {
		const v = verifyTrace(input({comments: [comment({})]}));
		expect(v.pass).toBe(true);
		expect(v.pass && v.approvedBy).toBe(FOUNDER);
		expect(v.pass && v.at).toBe("2026-07-10T12:00:00Z");
		expect(v.pass && v.waveLabel).toBe(WAVE);
	});

	it("tolerates a leading ** emphasis and case-insensitive keyword", () => {
		const v = verifyTrace(
			input({comments: [comment({body: `**Campaign-Approve: ${WAVE} · 2026-07-10T12:00:00Z`})]}),
		);
		expect(v.pass).toBe(true);
	});

	it("accepts a fractional-second ISO-8601 UTC timestamp", () => {
		const v = verifyTrace(
			input({comments: [comment({body: `campaign-approve: ${WAVE} · 2026-07-10T12:00:00.500Z`})]}),
		);
		expect(v.pass).toBe(true);
	});

	it("compares the founder login case-insensitively", () => {
		const v = verifyTrace(input({comments: [comment({author: "Founder-Login"})]}));
		expect(v.pass).toBe(true);
	});

	it("records the EARLIEST founder approval when several exist", () => {
		const v = verifyTrace(
			input({
				comments: [
					comment({id: 20, createdAt: "2026-07-10T15:00:00Z"}),
					comment({id: 10, createdAt: "2026-07-10T09:00:00Z", issue: 101}),
				],
			}),
		);
		expect(v.pass && v.commentId).toBe(10);
		expect(v.pass && v.issue).toBe(101);
	});

	it("PASSES on a founder approval even when a malformed attempt is also present", () => {
		const v = verifyTrace(
			input({
				comments: [
					comment({id: 5, body: "campaign-approve: garbage-no-separator"}),
					comment({id: 6}),
				],
			}),
		);
		expect(v.pass).toBe(true);
	});
});

describe("verifyTrace — fails closed on ABSENCE", () => {
	it("FAILS absent when the cluster carries no campaign-approve marker at all", () => {
		const v = asFail(
			verifyTrace(input({comments: [comment({body: "just a normal discussion comment"})]})),
		);
		expect(v.reason).toBe("absent");
	});

	it("FAILS absent when there are simply no comments", () => {
		const v = asFail(verifyTrace(input({comments: []})));
		expect(v.reason).toBe("absent");
	});

	it("does not treat a mid-body quote of the marker as an attempt (line-one anchored)", () => {
		const v = asFail(
			verifyTrace(
				input({
					comments: [
						comment({body: `I think we should\ncampaign-approve: ${WAVE} · 2026-07-10T12:00:00Z`}),
					],
				}),
			),
		);
		expect(v.reason).toBe("absent");
	});
});

describe("verifyTrace — fails closed on MALFORMATION", () => {
	it("FAILS malformed when the separator/timestamp is missing", () => {
		const v = asFail(
			verifyTrace(input({comments: [comment({body: `campaign-approve: ${WAVE}`})]})),
		);
		expect(v.reason).toBe("malformed");
	});

	it("FAILS malformed on a non-ISO timestamp", () => {
		const v = asFail(
			verifyTrace(input({comments: [comment({body: `campaign-approve: ${WAVE} · yesterday`})]})),
		);
		expect(v.reason).toBe("malformed");
	});

	it("FAILS malformed on a non-UTC (no Z) timestamp", () => {
		const v = asFail(
			verifyTrace(
				input({comments: [comment({body: `campaign-approve: ${WAVE} · 2026-07-10T12:00:00`})]}),
			),
		);
		expect(v.reason).toBe("malformed");
	});

	it("FAILS malformed on a calendar-invalid ISO timestamp (regex-shaped but not a real date)", () => {
		const v = asFail(
			verifyTrace(
				input({comments: [comment({body: `campaign-approve: ${WAVE} · 2026-13-45T99:99:99Z`})]}),
			),
		);
		expect(v.reason).toBe("malformed");
	});

	it("FAILS malformed (mis-bound) when a valid marker binds to a DIFFERENT wave — never authorizes this one", () => {
		const v = asFail(
			verifyTrace(
				input({
					comments: [comment({body: "campaign-approve: some-other-wave · 2026-07-10T12:00:00Z"})],
				}),
			),
		);
		expect(v.reason).toBe("malformed");
	});
});

describe("verifyTrace — fails closed on a NON-FOUNDER author", () => {
	it("FAILS non-founder-author for a well-formed marker authored by someone else", () => {
		const v = asFail(verifyTrace(input({comments: [comment({author: "some-agent"})]})));
		expect(v.reason).toBe("non-founder-author");
		expect(v.reason === "non-founder-author" && v.authors).toEqual(["some-agent"]);
	});

	it("does NOT PASS when a non-founder well-formed marker coexists with the founder's malformed one", () => {
		const v = asFail(
			verifyTrace(
				input({
					comments: [
						comment({id: 1, author: FOUNDER, body: `campaign-approve: ${WAVE}`}), // founder, malformed
						comment({id: 2, author: "other"}), // non-founder, well-formed
					],
				}),
			),
		);
		expect(v.reason).toBe("non-founder-author");
	});
});

describe("verifyTrace — fails closed on ZERO SCOPE (ADR 0092)", () => {
	it("FAILS zero-scope on an empty wave label", () => {
		const v = asFail(verifyTrace(input({waveLabel: "   ", comments: [comment({})]})));
		expect(v.reason).toBe("zero-scope");
	});

	it("FAILS zero-scope when no founder identity is configured (never a login fallback)", () => {
		const v = asFail(verifyTrace(input({founderLogin: "", comments: [comment({})]})));
		expect(v.reason).toBe("zero-scope");
	});

	it("FAILS zero-scope when the wave label names zero issues (empty cluster)", () => {
		const v = asFail(verifyTrace(input({clusterSize: 0, comments: []})));
		expect(v.reason).toBe("zero-scope");
	});

	it("a zero-scope cluster with a would-be founder marker still FAILS — an empty cluster cannot be approved", () => {
		const v = asFail(verifyTrace(input({clusterSize: 0, comments: [comment({})]})));
		expect(v.reason).toBe("zero-scope");
	});
});

describe("renderReport", () => {
	it("renders a PASS with the founder + timestamp evidence", () => {
		const report = renderReport(verifyTrace(input({comments: [comment({})]})));
		expect(report).toContain("PASS");
		expect(report).toContain(FOUNDER);
		expect(report).toContain(WAVE);
	});

	it("renders each FAIL reason with its detail", () => {
		expect(renderReport(verifyTrace(input({comments: []})))).toContain("FAIL (absent)");
		expect(renderReport(verifyTrace(input({clusterSize: 0})))).toContain("FAIL (zero-scope)");
		expect(renderReport(verifyTrace(input({comments: [comment({author: "x"})]})))).toContain(
			"FAIL (non-founder-author)",
		);
	});
});
