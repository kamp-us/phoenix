/**
 * The `pitch-guard` decision (#3963, founder ruling #3909): what counts as lane-entering work, the
 * tolerant five-field read, the fail-closed approval resolution, the two zero-scope forks (a backlog
 * sweep reds per ADR 0092, one out-of-scope issue passes), the report, and the seat each verdict
 * takes on the guard exit taxonomy. No IO — the board read is crossed in `./pitch-verb.ts`.
 */
import {describe, expect, it} from "vitest";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {type LabelUniverse, PRESENT} from "./label-universe.ts";
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
	readField,
	readPitch,
	renderReport,
	resolveApproval,
	SCOPE_LABELS,
	type Scope,
	toGuardVerdict,
} from "./pitch.ts";
import {verdictCode} from "./verdict.ts";

const GOOD_PITCH = [
	"## Pitch",
	"",
	"**Problem:** yazars cannot find a definition they wrote last week.",
	"**Arc:** sözlük discovery",
	"**Appetite:** 2 cycles",
	"**Rabbit-holes:** full-text ranking",
	"**No-gos:** a second search backend",
].join("\n");

const approval = (body: string, authorized = true): Comment => ({
	author: "founder",
	authorized,
	body,
});

const APPROVED = approval("pitch-approved: appetite 2 cycles · 2026-08-18T00:00:00Z");

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
	number: 4312,
	title: "sözlük search",
	labels: ["status:triaged", "type:feature"],
	hasParent: false,
	body: GOOD_PITCH,
	comments: [APPROVED],
	...over,
});

const BACKLOG: Scope = {_tag: "backlog"};
const issueScope = (number: number, universe: LabelUniverse = PRESENT): Scope => ({
	_tag: "issue",
	number,
	universe,
});
const ABSENT: LabelUniverse = {_tag: "absent", missing: [...SCOPE_LABELS]};

describe("the frozen scope literals", () => {
	it("names EXACTLY the two lane-entering types — widening it is a founder call", () => {
		expect([...LANE_ENTERING_TYPES]).toEqual(["type:epic", "type:feature"]);
	});

	it("names the five pitch fields in canonical order", () => {
		expect([...PITCH_FIELDS]).toEqual(["Problem", "Arc", "Appetite", "Rabbit-holes", "No-gos"]);
	});

	it("scopes an issue check on the triaged label plus both lane-entering types", () => {
		expect([...SCOPE_LABELS]).toEqual(["status:triaged", "type:epic", "type:feature"]);
	});
});

describe("isLaneEntering", () => {
	it("admits a triaged epic, parent or no parent — an epic is always a bet of its own", () => {
		expect(isLaneEntering(candidate({labels: ["status:triaged", "type:epic"]}))).toBe(true);
		expect(
			isLaneEntering(candidate({labels: ["status:triaged", "type:epic"], hasParent: true})),
		).toBe(true);
	});

	it("admits a parentless triaged feature and excludes the same feature under a parent", () => {
		expect(isLaneEntering(candidate())).toBe(true);
		expect(isLaneEntering(candidate({hasParent: true}))).toBe(false);
	});

	it("excludes an un-triaged issue — the requirement binds when triage makes it pickable", () => {
		expect(isLaneEntering(candidate({labels: ["type:feature"]}))).toBe(false);
	});

	it("excludes maintenance and questions — they are not bets", () => {
		for (const type of ["type:bug", "type:chore", "type:decision", "type:investigation"]) {
			expect(isLaneEntering(candidate({labels: ["status:triaged", type]}))).toBe(false);
		}
	});
});

describe("pitchSection", () => {
	it("reads the section from its heading to the next heading of any level", () => {
		const body = `${GOOD_PITCH}\n\n### Acceptance criteria\n\n- Problem: not a pitch field`;
		const section = pitchSection(body);
		expect(section).toContain("sözlük discovery");
		expect(section).not.toContain("not a pitch field");
	});

	it("answers null when the body carries no Pitch heading at all", () => {
		expect(pitchSection("## Summary\n\nProblem: inline prose")).toBeNull();
	});

	it("matches the heading at any level and in any case", () => {
		expect(pitchSection("###### pITCH\nbody")).toBe("body");
	});
});

describe("readField", () => {
	it("tolerates emphasis markers, casing, and `Rabbit holes` for `Rabbit-holes`", () => {
		expect(readField("**problem**: a thing", "Problem")).toBe("a thing");
		expect(readField("_Rabbit holes_: ranking", "Rabbit-holes")).toBe("ranking");
	});

	it("reads an EMPTY field as absent rather than swallowing the next line's value", () => {
		const section = "**Arc:**\n**Appetite:** 2 cycles";
		expect(readField(section, "Arc")).toBeNull();
		expect(readField(section, "Appetite")).toBe("2 cycles");
	});
});

describe("parseAppetiteCycles", () => {
	it("reads a whole positive number of cycles", () => {
		expect(parseAppetiteCycles("2 cycles")).toBe(2);
		expect(parseAppetiteCycles("1 cycle")).toBe(1);
	});

	it("refuses a duration estimate, a zero budget, and anything not leading with the number", () => {
		expect(parseAppetiteCycles("about three weeks")).toBeNull();
		expect(parseAppetiteCycles("0 cycles")).toBeNull();
		expect(parseAppetiteCycles("roughly 2 cycles")).toBeNull();
	});
});

describe("readPitch", () => {
	it("reads a complete pitch and carries its declared appetite", () => {
		expect(readPitch(GOOD_PITCH)).toEqual({_tag: "present", appetiteCycles: 2});
	});

	it("reports absent for a body with no section, and names every missing field", () => {
		expect(readPitch("no section here")).toEqual({_tag: "absent"});
		const read = readPitch("## Pitch\n\n**Problem:** a thing");
		expect(read).toMatchObject({_tag: "malformed"});
		if (read._tag !== "malformed") throw new Error("expected malformed");
		expect([...read.missing]).toEqual(["Arc", "Appetite", "Rabbit-holes", "No-gos"]);
	});

	it("does NOT read a BULLETED field — a list marker is prose, not the declared field", () => {
		const read = readPitch(
			GOOD_PITCH.split("\n")
				.map((line) => line.replace(/^\*\*/, "- **"))
				.join("\n"),
		);
		expect(read).toMatchObject({_tag: "malformed"});
		if (read._tag !== "malformed") throw new Error("expected malformed");
		expect([...read.missing]).toEqual([...PITCH_FIELDS]);
	});

	it("reports an unparseable Appetite as malformed rather than as a filled field", () => {
		const read = readPitch(GOOD_PITCH.replace("2 cycles", "about a month"));
		expect(read).toMatchObject({_tag: "malformed"});
		if (read._tag !== "malformed") throw new Error("expected malformed");
		expect(read.missing).toContain("Appetite (not a whole number of cycles)");
	});
});

describe("isAgentStamped", () => {
	it("catches the filing footer, a session UUID, and a claim marker", () => {
		expect(isAgentStamped("Filed by an agent.")).toBe(true);
		expect(isAgentStamped("session 3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(true);
		expect(isAgentStamped("claim: lane-7")).toBe(true);
	});

	it("leaves a plain founder comment unstamped", () => {
		expect(isAgentStamped("pitch-approved: appetite 2 cycles")).toBe(false);
	});
});

describe("resolveApproval", () => {
	it("approves a write+ marker whose appetite matches the body's", () => {
		expect(resolveApproval([APPROVED], 2)).toEqual({_tag: "approved", cycles: 2});
	});

	it("reports none when no comment carries the marker at all", () => {
		expect(resolveApproval([approval("looks good to me")], 2)).toEqual({_tag: "none"});
	});

	it("refuses a marker from below write+ — an unverifiable approval never counts (ADR 0055)", () => {
		expect(resolveApproval([approval("pitch-approved: appetite 2 cycles", false)], 2)).toEqual({
			_tag: "unauthorized",
		});
	});

	it("refuses an agent-stamped marker — approval is a founder seat", () => {
		const stamped = approval("pitch-approved: appetite 2 cycles\n\nFiled by an agent.");
		expect(resolveApproval([stamped], 2)).toEqual({_tag: "agent-authored"});
	});

	it("refuses a marker naming no appetite — approval must bind the number it approved", () => {
		expect(resolveApproval([approval("pitch-approved: go for it")], 2)).toEqual({
			_tag: "malformed-marker",
		});
	});

	it("reports a mismatch with both numbers, so the report can name the re-approval needed", () => {
		expect(resolveApproval([approval("pitch-approved: appetite 6 cycles")], 2)).toEqual({
			_tag: "appetite-mismatch",
			approved: 6,
			declared: 2,
		});
	});

	it("takes the one matching marker even when unusable markers sit beside it", () => {
		const comments = [
			approval("pitch-approved: appetite 9 cycles", false),
			approval("pitch-approved: appetite 2 cycles"),
		];
		expect(resolveApproval(comments, 2)).toEqual({_tag: "approved", cycles: 2});
	});
});

describe("disposition", () => {
	it("passes a complete, approved, lane-entering bet", () => {
		expect(disposition(candidate())).toEqual({_tag: "pitched", cycles: 2});
	});

	it("holds a sub-issue out of scope — it inherits its epic's pitch", () => {
		expect(disposition(candidate({hasParent: true, body: "", comments: []}))).toEqual({
			_tag: "out-of-scope",
		});
	});

	it("names the nearest miss for each unpitched shape", () => {
		expect(disposition(candidate({body: "nothing"}))).toMatchObject({
			detail: "has no `## Pitch` section",
		});
		expect(disposition(candidate({comments: []}))).toMatchObject({
			detail: expect.stringContaining("awaiting the founder"),
		});
		expect(
			disposition(candidate({comments: [approval("pitch-approved: appetite 6 cycles")]})),
		).toMatchObject({detail: expect.stringContaining("6 cycles but the body declares 2")});
	});
});

describe("judge", () => {
	it("passes a fully pitched backlog and counts what it scanned", () => {
		expect(judge([candidate(), candidate({number: 4313})], BACKLOG)).toEqual({
			pass: true,
			scope: BACKLOG,
			scanned: 2,
			pitched: 2,
		});
	});

	it("reds an empty BACKLOG sweep — a vacuous pass would hide every unpitched bet (ADR 0092)", () => {
		expect(judge([], BACKLOG)).toEqual({pass: false, reason: "zero-scope", scope: BACKLOG});
	});

	it("passes an empty ISSUE scope where the scoping labels exist — it is simply not a bet", () => {
		expect(judge([], issueScope(9))).toMatchObject({pass: true, scanned: 0});
	});

	it("refuses an empty ISSUE scope in a repo with no scoping labels (#4272)", () => {
		expect(judge([], issueScope(9, ABSENT))).toMatchObject({
			pass: false,
			reason: "vocabulary-absent",
			missing: SCOPE_LABELS,
		});
	});

	it("reds on the unpitched, keeps the pitched count, and ignores out-of-scope neighbours", () => {
		const verdict = judge(
			[
				candidate(),
				candidate({number: 4313, comments: []}),
				candidate({number: 4314, labels: ["status:triaged", "type:chore"]}),
			],
			BACKLOG,
		);
		expect(verdict).toMatchObject({pass: false, reason: "unpitched", scanned: 2, pitched: 1});
		if (verdict.pass || verdict.reason !== "unpitched") throw new Error("expected unpitched");
		expect(verdict.unpitched.map((one) => one.number)).toEqual([4313]);
	});
});

describe("renderReport", () => {
	it("states what a clean sweep covered rather than a bare all-clear", () => {
		expect(renderReport(judge([candidate()], BACKLOG))).toContain("scanned 1 lane-entering");
	});

	it("names the fail-closed reason on an empty backlog sweep", () => {
		expect(renderReport(judge([], BACKLOG))).toContain("ADR 0092");
	});

	it("names every offender and prints the draft/approve remedy once", () => {
		const report = renderReport(judge([candidate({comments: []})], BACKLOG));
		expect(report).toContain("#4312 sözlük search");
		expect(report).toContain("the FOUNDER approves it");
		expect(report).toContain(".glossary/TERMS.md");
	});
});

describe("toGuardVerdict", () => {
	it("seats each verdict on the guard exit taxonomy", () => {
		expect(verdictCode(toGuardVerdict(judge([candidate()], BACKLOG)))).toBe(0);
		expect(verdictCode(toGuardVerdict(judge([], BACKLOG)))).toBe(ZERO_SCOPE);
		expect(verdictCode(toGuardVerdict(judge([], issueScope(9, ABSENT))))).toBe(
			PRECONDITION_UNKNOWN,
		);
		expect(verdictCode(toGuardVerdict(judge([candidate({comments: []})], BACKLOG)))).toBe(
			VIOLATION,
		);
	});

	it("counts an issue-scoped pass as a scan of one, never of zero", () => {
		const verdict = toGuardVerdict(judge([], issueScope(9)));
		expect(verdict).toMatchObject({_tag: "Clean", scanned: 1});
	});
});
