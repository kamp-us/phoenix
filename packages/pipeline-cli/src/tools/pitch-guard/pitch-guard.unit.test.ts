/**
 * Pure-core tests for `pitch-guard` (#3963): the lane-entering scope predicate, the five-field
 * pitch read, the founder-approval rule (ACL / agent-stamp / appetite-binding), the verdict over
 * a scanned set, the two zero-scope forks (backlog fails closed per ADR 0092, a single
 * out-of-scope issue passes), and the report. No IO — the `gh api` seam is crossed in
 * `gate.ts`/`github.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {PRESENT, type VocabularyPresence} from "../vocabulary-preflight/presence.ts";
import {
	type Candidate,
	type Comment,
	disposition,
	isAgentStamped,
	isLaneEntering,
	judge,
	LANE_ENTERING_TYPES,
	PITCH_FIELDS,
	parseAppetiteCycles,
	pitchSection,
	readPitch,
	renderReport,
	resolveApproval,
	type Scope,
} from "./pitch-guard.ts";

const PITCH = `## Pitch

**Problem:** the factory starts work nobody bet on while the founder is AFK.
**Arc:** deterministic-crew-mechanics
**Appetite:** 2 cycles
**Rabbit-holes:** re-litigating the arc question in a second place.
**No-gos:** no merge-blocking conformance gate on shipped work.
`;

const approval = (over: Partial<Comment> = {}): Comment => ({
	author: "usirin",
	authorized: true,
	body: "pitch-approved: appetite 2 cycles · 2026-07-25T10:00:00Z",
	...over,
});

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
	number: 1,
	title: "a bet",
	labels: ["status:triaged", "type:feature"],
	hasParent: false,
	body: `some preamble\n\n${PITCH}`,
	comments: [approval()],
	...over,
});

const BACKLOG: Scope = {_tag: "backlog"};

// Issue scope defaults to a repo that HAS the scoping labels — the ordinary case. The absent
// reading is spelled out where it is the subject (#4272).
const issueScope = (number: number, vocabulary: VocabularyPresence = PRESENT): Scope => ({
	_tag: "issue",
	number,
	vocabulary,
});

describe("the frozen contract literals", () => {
	it("lane-entering types are EXACTLY epic + feature — widening is a founder call", () => {
		expect([...LANE_ENTERING_TYPES]).toEqual(["type:epic", "type:feature"]);
	});

	it("the pitch is EXACTLY the five §PITCH fields, in canonical order", () => {
		expect([...PITCH_FIELDS]).toEqual(["Problem", "Arc", "Appetite", "Rabbit-holes", "No-gos"]);
	});
});

describe("isLaneEntering", () => {
	it("a triaged epic is lane-entering even with a parent", () => {
		expect(
			isLaneEntering(candidate({labels: ["status:triaged", "type:epic"], hasParent: true})),
		).toBe(true);
	});

	it("a triaged parentless feature is lane-entering", () => {
		expect(isLaneEntering(candidate())).toBe(true);
	});

	it("a feature WITH a parent inherits its epic's pitch — out of scope", () => {
		expect(isLaneEntering(candidate({hasParent: true}))).toBe(false);
	});

	it.each([
		"type:bug",
		"type:chore",
		"type:decision",
		"type:investigation",
	])("%s is maintenance or a question, never a bet", (type) => {
		expect(isLaneEntering(candidate({labels: ["status:triaged", type]}))).toBe(false);
	});

	it("an un-triaged feature is not yet pickable, so the requirement has not bound", () => {
		expect(isLaneEntering(candidate({labels: ["type:feature"]}))).toBe(false);
	});
});

describe("pitchSection", () => {
	it("stops at the next heading of any level", () => {
		const section = pitchSection(`${PITCH}\n### Acceptance criteria\n**Problem:** not this\n`);
		expect(section).toContain("deterministic-crew-mechanics");
		expect(section).not.toContain("not this");
	});

	it("a plan-epic body's `### Problem & who has it` is not a pitch", () => {
		expect(pitchSection("### Problem & who has it\nprose\n")).toBeNull();
	});
});

describe("readPitch", () => {
	it("reads a canonical pitch", () => {
		expect(readPitch(PITCH)).toEqual({_tag: "present", pitch: {appetiteCycles: 2}});
	});

	it("reads tolerantly — no bold, odd case, `Rabbit holes` unhyphenated", () => {
		const loose = `## PITCH\nproblem: who hurts\nARC: some-arc\nappetite: 1 cycle\nRabbit holes: a trap\nno-gos: not this\n`;
		expect(readPitch(loose)).toEqual({_tag: "present", pitch: {appetiteCycles: 1}});
	});

	it("no `## Pitch` section is absent, not malformed", () => {
		expect(readPitch("just a body")).toEqual({_tag: "absent"});
	});

	it("names every missing field", () => {
		const partial = "## Pitch\n\n**Problem:** who hurts\n**Appetite:** 1 cycle\n";
		expect(readPitch(partial)).toEqual({
			_tag: "malformed",
			missing: ["Arc", "Rabbit-holes", "No-gos"],
		});
	});

	it("an empty field value is missing, not present", () => {
		const blank = PITCH.replace("**Arc:** deterministic-crew-mechanics", "**Arc:**");
		expect(readPitch(blank)).toEqual({_tag: "malformed", missing: ["Arc"]});
	});
});

describe("parseAppetiteCycles", () => {
	it.each([
		["2 cycles", 2],
		["1 cycle", 1],
		["3  Cycles", 3],
	])("%s reads as %i", (value, expected) => {
		expect(parseAppetiteCycles(value)).toBe(expected);
	});

	it.each([
		"0 cycles",
		"two cycles",
		"2 weeks",
		"soon",
		"",
	])("%s is not a whole positive number of cycles", (value) => {
		expect(parseAppetiteCycles(value)).toBeNull();
	});
});

describe("isAgentStamped", () => {
	it.each([
		"pitch-approved: appetite 2 cycles\n<sub>Filed by an agent</sub>",
		"pitch-approved: appetite 2 cycles · session 2f6337d4-59a4-47ad-9ec9-ade62e76580f",
		"claim: 2f6337d4-59a4-47ad-9ec9-ade62e76580f · 2026-07-25T10:00:00Z",
	])("a provenance-stamped comment is agent-authored", (body) => {
		expect(isAgentStamped(body)).toBe(true);
	});

	it("an unstamped marker is not", () => {
		expect(isAgentStamped(approval().body)).toBe(false);
	});
});

describe("resolveApproval", () => {
	it("an unstamped write+ marker naming the declared appetite approves", () => {
		expect(resolveApproval([approval()], 2)).toEqual({_tag: "approved", cycles: 2});
	});

	it("no marker at all is `none`", () => {
		expect(resolveApproval([{author: "usirin", authorized: true, body: "lgtm"}], 2)).toEqual({
			_tag: "none",
		});
	});

	it("a non-collaborator marker is unauthorized, never silently absent (ADR 0055)", () => {
		expect(resolveApproval([approval({authorized: false})], 2)).toEqual({_tag: "unauthorized"});
	});

	it("an AGENT-authored marker does NOT satisfy the guard — approval is a founder seat", () => {
		const stamped = approval({
			body: "pitch-approved: appetite 2 cycles · 2026-07-25T10:00:00Z\n<sub>Filed by an agent · session 2f6337d4-59a4-47ad-9ec9-ade62e76580f</sub>",
		});
		expect(resolveApproval([stamped], 2)).toEqual({_tag: "agent-authored"});
	});

	it("a marker naming no appetite is malformed — approval must bind a number", () => {
		expect(resolveApproval([approval({body: "pitch-approved: yes"})], 2)).toEqual({
			_tag: "malformed-marker",
		});
	});

	it("an approval for a different appetite does not carry over to a rewritten one", () => {
		expect(resolveApproval([approval()], 5)).toEqual({
			_tag: "appetite-mismatch",
			approved: 2,
			declared: 5,
		});
	});

	it("one valid founder approval survives alongside agent and forged markers", () => {
		const comments = [
			approval({authorized: false}),
			approval({
				body: "pitch-approved: appetite 2 cycles · session 2f6337d4-59a4-47ad-9ec9-ade62e76580f",
			}),
			approval(),
		];
		expect(resolveApproval(comments, 2)).toEqual({_tag: "approved", cycles: 2});
	});
});

describe("disposition", () => {
	it("a pitched, founder-approved bet passes", () => {
		expect(disposition(candidate())).toEqual({_tag: "pitched", cycles: 2});
	});

	it("out-of-scope work is neither pitched nor unpitched", () => {
		expect(disposition(candidate({hasParent: true}))).toEqual({_tag: "out-of-scope"});
	});

	it("a missing pitch names the missing section", () => {
		const d = disposition(candidate({body: "no pitch here"}));
		expect(d._tag).toBe("unpitched");
	});

	it("an unapproved pitch is awaiting the founder, not a malformed draft", () => {
		const d = disposition(candidate({comments: []}));
		expect(d).toEqual({
			_tag: "unpitched",
			detail:
				"carries a well-formed pitch but no founder `pitch-approved:` comment — awaiting the founder",
		});
	});
});

describe("judge", () => {
	it("passes a fully-pitched backlog", () => {
		expect(judge([candidate(), candidate({number: 2})], BACKLOG)).toEqual({
			pass: true,
			scope: BACKLOG,
			scanned: 2,
			pitched: 2,
		});
	});

	it("an empty BACKLOG fails closed — a vacuous pass would hide every unpitched bet (ADR 0092)", () => {
		expect(judge([], BACKLOG)).toEqual({pass: false, reason: "zero-scope", scope: BACKLOG});
	});

	it("a backlog of only out-of-scope issues is still zero scope", () => {
		expect(judge([candidate({hasParent: true})], BACKLOG)).toEqual({
			pass: false,
			reason: "zero-scope",
			scope: BACKLOG,
		});
	});

	it("a single out-of-scope ISSUE passes — that is the ordinary answer, not a broken read", () => {
		const scope: Scope = issueScope(7);
		expect(judge([candidate({number: 7, hasParent: true})], scope)).toEqual({
			pass: true,
			scope,
			scanned: 0,
			pitched: 0,
		});
	});

	// The two readings of the SAME empty per-issue result. The pass above is the first; this is the
	// second, which used to be indistinguishable from it and reported clean forever (#4272).
	it("FAILS the same empty scan when the scoping labels are absent from the REPO", () => {
		const scope: Scope = issueScope(7, {
			_tag: "absent",
			missing: ["status:triaged", ...LANE_ENTERING_TYPES],
		});
		const verdict = judge([candidate({number: 7, hasParent: true})], scope);
		expect(verdict.pass).toBe(false);
		if (!verdict.pass && verdict.reason === "vocabulary-absent") {
			expect(verdict.missing).toContain("status:triaged");
		}
	});

	it("reds on an unpitched bet and counts only in-scope work", () => {
		const verdict = judge(
			[
				candidate(),
				candidate({number: 2, body: "no pitch"}),
				candidate({number: 3, hasParent: true}),
			],
			BACKLOG,
		);
		expect(verdict.pass).toBe(false);
		if (verdict.pass || verdict.reason !== "unpitched")
			throw new Error("expected an unpitched red");
		expect(verdict.scanned).toBe(2);
		expect(verdict.pitched).toBe(1);
		expect(verdict.unpitched.map((u) => u.number)).toEqual([2]);
	});
});

describe("renderReport", () => {
	it("emits what it scanned on a pass (ADR 0092 §1)", () => {
		expect(renderReport(judge([candidate()], BACKLOG))).toContain("scanned 1");
	});

	it("names the zero-scope fail-closed reason rather than reporting clean", () => {
		expect(renderReport(judge([], BACKLOG))).toContain("fail-closed (ADR 0092)");
	});

	it("a red carries the offender and the draft/approve remedy", () => {
		const report = renderReport(judge([candidate({body: "no pitch"})], BACKLOG));
		expect(report).toContain("#1 a bet");
		expect(report).toContain("Approval is a founder seat");
	});

	it("an out-of-scope single issue reports out-of-scope, not clean-pitched", () => {
		const scope: Scope = issueScope(7);
		expect(renderReport(judge([candidate({number: 7, hasParent: true})], scope))).toContain(
			"not lane-entering work",
		);
	});

	it("an absent label universe reports the unmet prerequisite, naming the missing labels", () => {
		const scope: Scope = issueScope(7, {_tag: "absent", missing: ["status:triaged"]});
		const report = renderReport(judge([candidate({number: 7, hasParent: true})], scope));
		expect(report).toContain("do not exist in this repo at all: status:triaged");
		expect(report).toContain("vocabulary-preflight");
	});
});
