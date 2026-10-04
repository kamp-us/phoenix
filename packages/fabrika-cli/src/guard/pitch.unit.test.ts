/**
 * The `pitch-guard` decision: what counts as lane-entering work, the tolerant five-field read, the
 * fail-closed approval resolution and the verdict over a scanned set. No IO. The zero-scope forks,
 * the exit seats and the report lines a reader acts on are proven through the board read in
 * `./pitch-verb.unit.test.ts`.
 */
import {describe, expect, it} from "vitest";
import {SHIPPED_APPETITE_SIZES} from "../config/keys/appetite-sizes.ts";
import {scanRulings} from "../decision/ruling.ts";
import {
	emit as emitRuling,
	markedIssue,
	type RulingUrl,
	rulingUrl,
	scopeDigest,
} from "../wire/decision-ruling.ts";
import {markerTime} from "../wire/grill-marker.ts";
import {type LabelUniverse, PRESENT} from "./label-universe.ts";
import {
	type Appetite,
	type BetRow,
	type BetTable,
	type Candidate,
	type Comment,
	describeAppetite,
	disposition,
	isAgentStamped,
	isLaneEntering,
	judge,
	LANE_ENTERING_TYPES,
	type OtherRulingRead,
	PITCH_FIELDS,
	type PointedRuling,
	parseAppetite,
	parseAppetiteCycles,
	pitchSection,
	readField,
	readPitch,
	renderReport,
	resolveApproval,
	resolveBetApproval,
	rulingPointers,
	SCOPE_LABELS,
	type Scope,
	toGuardVerdict,
} from "./pitch.ts";

const GOOD_PITCH = [
	"## Pitch",
	"",
	"**Problem:** yazars cannot find a definition they wrote last week.",
	"**Arc:** product search discovery",
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

const SIZED_PITCH = GOOD_PITCH.replace("2 cycles", "M");
const SIZE_APPROVED = approval("pitch-approved: appetite M · 2026-09-26T00:00:00Z");

const cycles = (n: number): Appetite => ({_tag: "cycles", cycles: n});
const size = (letter: "S" | "M" | "L"): Appetite => ({_tag: "size", size: letter});
const SIZES = SHIPPED_APPETITE_SIZES;

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
	number: 4312,
	title: "product search",
	labels: ["status:triaged", "type:feature"],
	hasParent: false,
	milestone: null,
	body: GOOD_PITCH,
	comments: [APPROVED],
	rulings: [],
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
		expect(section).toContain("product search discovery");
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
		expect(readPitch(GOOD_PITCH)).toEqual({_tag: "present", appetite: cycles(2), success: null});
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
		expect(read.missing).toContain("Appetite (not a size S / M / L, nor a whole number of cycles)");
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
	it("reports none when no comment carries the marker at all", () => {
		expect(resolveApproval([approval("looks good to me")], cycles(2))).toEqual({_tag: "none"});
	});

	it("refuses an agent-stamped marker — a stamped comment never approves", () => {
		const stamped = approval("pitch-approved: appetite 2 cycles\n\nFiled by an agent.");
		expect(resolveApproval([stamped], cycles(2))).toEqual({_tag: "agent-authored"});
	});

	it("refuses a marker naming no appetite — approval must bind the number it approved", () => {
		expect(resolveApproval([approval("pitch-approved: go for it")], cycles(2))).toEqual({
			_tag: "malformed-marker",
		});
	});

	it("reports a mismatch with both numbers, so the report can name the re-approval needed", () => {
		expect(resolveApproval([approval("pitch-approved: appetite 6 cycles")], cycles(2))).toEqual({
			_tag: "appetite-mismatch",
			approved: cycles(6),
			declared: cycles(2),
		});
	});

	it("takes the one matching marker even when unusable markers sit beside it", () => {
		const comments = [
			approval("pitch-approved: appetite 9 cycles", false),
			approval("pitch-approved: appetite 2 cycles"),
		];
		expect(resolveApproval(comments, cycles(2))).toEqual({
			_tag: "approved",
			appetite: cycles(2),
		});
	});
});

describe("disposition", () => {
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
			ruled: [],
		});
	});

	it("refuses an empty ISSUE scope in a repo with no scoping labels", () => {
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

describe("toGuardVerdict", () => {
	it("counts an issue-scoped pass as a scan of one, never of zero", () => {
		const verdict = toGuardVerdict(judge([], issueScope(9)), SIZES);
		expect(verdict).toMatchObject({_tag: "Clean", scanned: 1});
	});
});

describe("appetite as a size — S / M / L, with N cycles kept as the legacy read", () => {
	it("reads an upper-case size letter, with or without a trailing note", () => {
		expect(parseAppetite("M")).toEqual(size("M"));
		expect(parseAppetite("L ($40 per child)")).toEqual(size("L"));
		expect(parseAppetite("2 cycles")).toEqual(cycles(2));
	});

	it("refuses a lower-case letter, a spelled-out size and an unknown letter", () => {
		expect(parseAppetite("m")).toBeNull();
		expect(parseAppetite("Medium")).toBeNull();
		expect(parseAppetite("XL")).toBeNull();
		expect(parseAppetite("S-ish")).toBeNull();
	});

	it("describes each arm the way a pitch writes it", () => {
		expect(describeAppetite(size("S"))).toBe("S");
		expect(describeAppetite(cycles(3))).toBe("3 cycles");
	});

	it("still passes a legacy `2 cycles` pitch against its `appetite 2 cycles` approval", () => {
		expect(disposition(candidate())).toEqual({_tag: "pitched", appetite: cycles(2)});
	});

	it("refuses a size approval that disagrees with the body's size, asking for re-approval", () => {
		const drifted = candidate({
			body: SIZED_PITCH.replace("**Appetite:** M", "**Appetite:** L"),
			comments: [SIZE_APPROVED],
		});
		expect(resolveApproval(drifted.comments, size("L"))).toEqual({
			_tag: "appetite-mismatch",
			approved: size("M"),
			declared: size("L"),
		});
		expect(disposition(drifted)).toEqual({
			_tag: "unpitched",
			detail: "its approval names appetite M but the body declares L — re-approval needed",
		});
	});

	it("refuses a cycles approval over a size body, and a size approval over a cycles body", () => {
		expect(disposition(candidate({body: SIZED_PITCH, comments: [APPROVED]}))).toMatchObject({
			detail: expect.stringContaining("2 cycles but the body declares M"),
		});
		expect(disposition(candidate({comments: [SIZE_APPROVED]}))).toMatchObject({
			detail: expect.stringContaining("appetite M but the body declares 2 cycles"),
		});
	});

	it("reads a lower-case size in the approval as naming no appetite", () => {
		expect(
			resolveApproval([approval("pitch-approved: appetite m · 2026-09-26")], size("M")),
		).toEqual({_tag: "malformed-marker"});
	});
});

describe("the optional Success line", () => {
	it("carries the sentence the two-week check judges when the pitch names one", () => {
		const body = `${SIZED_PITCH}\n**Success:** half of new yazars find last week's entry in one search`;
		expect(readPitch(body)).toEqual({
			_tag: "present",
			appetite: size("M"),
			success: "half of new yazars find last week's entry in one search",
		});
	});

	it("leaves a pitch without it well-formed", () => {
		expect(readPitch(SIZED_PITCH)).toMatchObject({_tag: "present", success: null});
	});
});

describe("the bet arm — a `bet` on the table approves the pitch", () => {
	const sized = (over: Partial<Candidate> = {}): Candidate =>
		candidate({body: SIZED_PITCH, comments: [], ...over});
	const row = (over: Partial<BetRow> = {}): BetRow => ({
		head: 4312,
		covers: [4312],
		size: "M",
		headAppetite: {_tag: "stated", appetite: size("M")},
		setter: "founder",
		authorized: true,
		...over,
	});
	const table = (...rows: ReadonlyArray<BetRow>): BetTable => ({
		_tag: "read",
		source: "o#1",
		rows,
	});

	it("counts a `bet` an agent set under a write+ token — the setter's ACL is the whole bar", () => {
		const agent = table(row({setter: "agent-under-founder-token"}));
		expect(resolveBetApproval(4312, agent, size("M"))).toMatchObject({_tag: "approved"});
	});

	it("approves the head and every member of a group row, whatever a member's own size", () => {
		const group = table(
			row({
				head: 50,
				covers: [50, 51, 52],
				size: "L",
				headAppetite: {_tag: "stated", appetite: size("L")},
			}),
		);
		expect(resolveBetApproval(50, group, size("L"))).toMatchObject({_tag: "approved"});
		expect(resolveBetApproval(51, group, size("S"))).toMatchObject({_tag: "approved"});
		expect(resolveBetApproval(52, group, cycles(2))).toMatchObject({_tag: "approved"});
		const head = sized({
			number: 50,
			body: SIZED_PITCH.replace("**Appetite:** M", "**Appetite:** L"),
		});
		expect(judge([head, sized({number: 51})], BACKLOG, group)).toMatchObject({
			pass: true,
			pitched: 2,
		});
	});

	it("binds a member's approval to the appetite its own pitch states, never to the row's Size", () => {
		const group = table(
			row({
				head: 50,
				covers: [50, 51],
				size: "L",
				headAppetite: {_tag: "stated", appetite: size("L")},
			}),
		);
		expect(disposition(sized({number: 51}), group)).toEqual({
			_tag: "pitched",
			appetite: size("M"),
		});
	});

	it("approves no member when the group row's Size is not the size its head's pitch declares", () => {
		const cases: ReadonlyArray<readonly [BetRow["headAppetite"], string]> = [
			[{_tag: "stated", appetite: size("S")}, "it is sized L but its head #50 declares S"],
			[{_tag: "stated", appetite: cycles(2)}, "its head #50 states a legacy `2 cycles` appetite"],
			[{_tag: "unstated"}, "its head #50 carries no well-formed pitch"],
			[{_tag: "unread", reason: "HTTP 502"}, "its head's pitch could not be read (HTTP 502)"],
		];
		for (const [headAppetite, why] of cases) {
			const group = table(row({head: 50, covers: [50, 51], size: "L", headAppetite}));
			expect(resolveBetApproval(51, group, size("M"))).toEqual({
				_tag: "group-unbacked",
				head: 50,
				why,
			});
			expect(disposition(sized({number: 51}), group)).toMatchObject({
				_tag: "unpitched",
				detail: expect.stringContaining(`approves no member: ${why}`),
			});
		}
	});

	it("refuses a `bet` row with no Size, and one over a legacy cycles pitch", () => {
		expect(resolveBetApproval(4312, table(row({size: null})), size("M"))).toEqual({
			_tag: "no-size",
			head: 4312,
		});
		expect(disposition(candidate({comments: []}), table(row()))).toMatchObject({
			detail: expect.stringContaining("cannot approve a legacy `<N> cycles` pitch"),
		});
	});

	it("names the table's miss beside the comment's when neither carrier approves", () => {
		expect(disposition(sized(), table())).toMatchObject({
			detail: expect.stringContaining("; and no `bet` row on the table covers it"),
		});
	});

	it("says in the remedy that a `bet` on the table is the approval", () => {
		const report = renderReport(judge([sized()], BACKLOG), SIZES);
		expect(report).toContain("a `bet` on the table");
	});
});

describe("a founder ruling that names a parentless feature stands in for its pitch", () => {
	const REPO = "o/r";
	const url = (issue: number, comment: number): RulingUrl =>
		rulingUrl(`https://github.com/${REPO}/issues/${issue}#issuecomment-${comment}`) ??
		("" as never);
	const OWN = url(4312, 900);
	const OTHER = url(8070, 501);

	/** `standingRulings`' scan of the feature holding one marker that cites {@link OWN}, by `author`. */
	const scanBy = (author: string) =>
		scanRulings(
			[
				{
					id: 901,
					author,
					createdAt: "2026-10-03T00:00:00Z",
					updatedAt: "2026-10-03T00:00:00Z",
					body: emitRuling({
						issue: markedIssue(4312) ?? (0 as never),
						digest: scopeDigest("4d90e1bb27ac") ?? ("" as never),
						ruling: OWN,
						supersedes: null,
						at: markerTime("2026-10-03T00:00:00Z") ?? ("" as never),
					}),
				},
			],
			4312,
			new Set(["founder"]),
		);

	const own = (author = "founder"): PointedRuling => ({
		_tag: "own",
		url: OWN,
		read: {_tag: "scanned", scan: scanBy(author)},
	});

	const RULING_TEXT = "Ruling 5: #4312 ships with the search arc.";
	const other = (read: Partial<Extract<OtherRulingRead, {_tag: "read"}>> = {}): PointedRuling => ({
		_tag: "other",
		url: OTHER,
		issue: 8070,
		read: {
			_tag: "read",
			authorized: true,
			body: RULING_TEXT,
			milestone: {number: 52, open: true},
			...read,
		},
	});

	const MALFORMED_PITCH = GOOD_PITCH.replace("**Arc:** product search discovery\n", "");

	it("passes ahead of the body: no pitch, a malformed one, or a well-formed one nobody approved", () => {
		for (const body of ["no pitch here", MALFORMED_PITCH, GOOD_PITCH]) {
			expect(disposition(candidate({body, comments: [], rulings: [own()]}))).toEqual({
				_tag: "ruled",
				ruling: OWN,
			});
		}
	});

	it("judges an epic carrying the same pointer as an epic: it still owes its pitch", () => {
		const epic = candidate({
			labels: ["status:triaged", "type:epic"],
			body: "no pitch here",
			comments: [],
			rulings: [own()],
		});
		expect(disposition(epic)).toEqual({_tag: "unpitched", detail: "has no `## Pitch` section"});
	});

	it("binds a pointer to this feature and this repository before anything is read", () => {
		const pointers = (body: string) => rulingPointers(4312, [{body}], "o/r");
		expect(pointers(`pitch-ruled: #4312 · ruling:${OWN}`)).toEqual([{_tag: "own", url: OWN}]);
		expect(pointers(`pitch-ruled: #4312 · ruling:${OTHER}`)).toEqual([
			{_tag: "other", url: OTHER, issue: 8070, comment: 501},
		]);
		expect(pointers(`pitch-ruled: #4313 · ruling:${OWN}`)).toEqual([
			{_tag: "misnumbered", names: 4313},
		]);
		const elsewhere = OWN.replace("o/r", "o/elsewhere");
		expect(pointers(`pitch-ruled: #4312 · ruling:${elsewhere}`)).toEqual([
			{_tag: "foreign", url: elsewhere},
		]);
		expect(pointers(`Pitch covered by the ruling at ${OWN}`)).toEqual([]);
	});

	it("passes no pointer that names another issue or links outside the repository", () => {
		const misses: ReadonlyArray<readonly [PointedRuling, string]> = [
			[{_tag: "misnumbered", names: 4313}, "names #4313, not #4312"],
			[{_tag: "foreign", url: OWN}, "which is not an issue comment in this repository"],
		];
		for (const [pointed, why] of misses) {
			expect(disposition(candidate({body: "", comments: [], rulings: [pointed]}))).toEqual({
				_tag: "unpitched",
				detail: expect.stringContaining(why),
			});
		}
	});

	it("counts a ruling on the feature's own issue only on a control-plane account's marker citing it", () => {
		expect(disposition(candidate({comments: [], rulings: [own("drive-by")]}))).toMatchObject({
			_tag: "unpitched",
			detail: expect.stringContaining(
				"no `decision-ruled:` marker from a control-plane account cites that comment",
			),
		});
		const uncited: PointedRuling = {
			_tag: "own",
			url: url(4312, 77),
			read: {_tag: "scanned", scan: scanBy("founder")},
		};
		expect(disposition(candidate({comments: [], rulings: [uncited]}))._tag).toBe("unpitched");
	});

	it("holds a ruling on another issue to its author, its stamp, the number it names and one open milestone", () => {
		const homed = (over: Partial<Candidate> = {}) =>
			candidate({body: "", comments: [], milestone: 52, ...over});
		expect(disposition(homed({rulings: [other()]}))).toEqual({_tag: "ruled", ruling: OTHER});

		const misses: ReadonlyArray<readonly [Candidate, string]> = [
			[homed({rulings: [other({authorized: false})]}), "whose author is not a write+ collaborator"],
			[
				homed({rulings: [other({body: `${RULING_TEXT}\n\n<sub>Filed by an agent</sub>`})]}),
				"agent-provenance-stamped",
			],
			[homed({rulings: [other({body: "Ruling 5: #43120 ships."})]}), "does not name #4312"],
			[homed({number: 431, rulings: [other()]}), "does not name #431"],
			[homed({rulings: [other({body: "Ruling 5: o/elsewhere#4312 ships."})]}), "does not name"],
			[
				homed({rulings: [other({milestone: {number: 53, open: true}})]}),
				"do not share an open milestone",
			],
			[
				homed({rulings: [other({milestone: {number: 52, open: false}})]}),
				"do not share an open milestone",
			],
			[homed({rulings: [other({milestone: null})]}), "do not share an open milestone"],
			[
				homed({rulings: [{_tag: "other", url: OTHER, issue: 8070, read: {_tag: "missing"}}]}),
				"#8070 carries no comment with that id",
			],
		];
		for (const [feature, why] of misses) {
			expect(disposition(feature)).toEqual({
				_tag: "unpitched",
				detail: expect.stringContaining(why),
			});
		}
	});

	it("passes no feature without a milestone on another issue's ruling, shared lane label or not", () => {
		const onLane = candidate({
			labels: ["status:triaged", "type:feature", "axis:pipeline-hardening"],
			body: "",
			comments: [],
			rulings: [other({milestone: null})],
		});
		expect(disposition(onLane)).toEqual({
			_tag: "unpitched",
			detail: expect.stringContaining("#4312 is on no milestone"),
		});
	});

	it("reports an unread ruling as unread, never as a pass and never as a missing pitch", () => {
		const unread: ReadonlyArray<PointedRuling> = [
			{_tag: "own", url: OWN, read: {_tag: "unread", reason: "the roster read answered 502"}},
			{
				_tag: "other",
				url: OTHER,
				issue: 8070,
				read: {_tag: "unread", reason: "the comments on #8070 could not be read: HTTP 502"},
			},
		];
		for (const pointed of unread) {
			const feature = candidate({body: "no pitch here", comments: [], rulings: [pointed]});
			const resolved = disposition(feature);
			expect(resolved._tag).toBe("unread");
			expect(resolved).toMatchObject({detail: expect.stringContaining("502")});
			expect(resolved).not.toMatchObject({detail: expect.stringContaining("## Pitch")});

			const verdict = judge([feature], BACKLOG);
			expect(verdict).toMatchObject({pass: false, reason: "unread"});
			expect(toGuardVerdict(verdict, SIZES)._tag).toBe("Unknown");
			expect(renderReport(verdict, SIZES)).toContain("could not be read");
		}
		// An approved pitch needs no ruling, so one that went unread costs it nothing.
		expect(disposition(candidate({rulings: unread}))._tag).toBe("pitched");
	});

	it("names a drifted pointer beside the pitch's own miss, and adds nothing where there is none", () => {
		const [drifted] = rulingPointers(4312, [{body: `pitch-ruled: #4312 · ${OWN}`}], "o/r");
		if (drifted?._tag !== "malformed") throw new Error("expected the drifted pointer to be read");
		const bare = candidate({body: "no pitch here", comments: []});
		expect(disposition(bare)).toEqual({_tag: "unpitched", detail: "has no `## Pitch` section"});
		expect(disposition({...bare, rulings: [drifted]})).toEqual({
			_tag: "unpitched",
			detail: expect.stringMatching(
				/^has no `## Pitch` section; and its `pitch-ruled:` comment does not read as /,
			),
		});
	});

	it("counts the features that passed on a ruling and lists each with its ruling", () => {
		const ruled = candidate({
			number: 4313,
			title: "saved searches",
			comments: [],
			rulings: [own()],
		});
		const passing = judge([candidate(), ruled], BACKLOG);
		expect(passing).toMatchObject({pass: true, scanned: 2, pitched: 1});
		const report = renderReport(passing, SIZES);
		expect(report).toContain("1 carrying a founder-approved pitch, 1 passed by a founder ruling");
		expect(report).toContain(`#4313 saved searches\n      ruling: ${OWN}`);

		const failing = renderReport(judge([ruled, candidate({comments: []})], BACKLOG), SIZES);
		expect(failing).toContain("(0 pitched, 1 passed by a founder ruling)");
		expect(failing).toContain(`ruling: ${OWN}`);
		expect(failing).toContain("passes a third way");
		expect(failing).toContain("pitch-ruled: #<n> · ruling:");
	});
});
