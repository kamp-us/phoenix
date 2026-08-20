import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeSeams, once, type Scripted} from "../fakes.test-support.ts";
import {
	AUTHORIZATION,
	answerComment,
	roundComment,
	roundDigestOf,
	rulingComment,
} from "../grill/fixtures.test-support.ts";
import {type DecisionEntry, renderDecision, renderOutOfScope, spliceSection} from "./body.ts";
import {
	BAD_SECTIONS,
	NO_TARGET,
	OUTCOME_UNRECORDABLE,
	PRECONDITION_UNKNOWN,
	TICKET_UNKNOWN,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {runDescope} from "./descope-verb.ts";
import {
	commentsJson,
	digestFor,
	issueJson,
	MAP,
	MAP_BODY,
	NONCE,
	parsed,
	REPO,
	TICKET,
} from "./fixtures.test-support.ts";
import {
	composeFindingMarker,
	composeForkMarker,
	composeLaneMarker,
	composeTicketMarker,
} from "./markers.ts";
import {applyRecord} from "./record.ts";
import {runRecord} from "./record-verb.ts";

const PERMISSION = /collaborators\/.*\/permission/;
const CHILDREN = /issues\/9140\/sub_issues/;
const TICKET_COMMENTS = /issues\/9142\/comments/;
const EDGES = /issues\/9142\/dependencies\//;
const TICKET_ISSUE = /issues\/9142$/;
const MAP_ISSUE = /issues\/9140$/;
const PATCH_MAP = /PATCH .*\/issues\/9140/;
const PATCH_TICKET = /PATCH .*\/issues\/9142/;

const served = (body: string) => ({status: 200, body}) as const;

type Seams = ReturnType<typeof fakeSeams>;

/** The JSON bodies of every `PATCH …/issues/9140` the run issued, in order. */
const mapPatches = (seams: Seams): ReadonlyArray<string> =>
	seams.requests
		.map((line, index) => ({line, body: seams.bodies[index] ?? ""}))
		.filter(({line}) => line.startsWith("PATCH") && line.includes("/issues/9140"))
		.map(({body}) => body);

const mapPatchAt = (seams: Seams): number =>
	seams.requests.findIndex((line) => line.startsWith("PATCH") && line.includes("/issues/9140"));

const closeAt = (seams: Seams): number =>
	seams.bodies.findIndex((body) => body.includes('"state_reason":"completed"'));

const FINDING = "finding.md";
const ANSWER = "the weight column lives on the account row";

const options = {
	map: MAP,
	digest: digestFor(MAP_BODY),
	ticket: TICKET,
	finding: FINDING,
	ruledOn: null as number | null,
	spike: null as number | null,
	questionId: null as string | null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: REPO},
};

const run = (
	script: ReadonlyArray<Scripted>,
	over: Partial<typeof options> = {},
	files: Readonly<Record<string, string | null>> = {[FINDING]: `${ANSWER}\n`},
) =>
	Effect.runPromise(
		Effect.provide(
			runRecord({...options, ...over}),
			Layer.merge(fakeSeams(script).layer, fakeFs({files}).layer),
		),
	);

const ticketComments = (
	extra: ReadonlyArray<{readonly id: number; readonly body: string}> = [],
	kind: "research" | "decision" | "prototype" = "research",
) => commentsJson([{id: 1, body: composeTicketMarker({map: MAP, kind, nonce: NONCE})}, ...extra]);

const frontier = (comments: string): ReadonlyArray<Scripted> => [
	[PERMISSION, served('{"permission":"write"}')],
	[CHILDREN, served(`[{"number":${TICKET}}]`)],
	[TICKET_COMMENTS, served(comments)],
	[EDGES, served("[]")],
	[TICKET_ISSUE, served(issueJson({number: TICKET, body: "which table carries it?"}))],
];

const laneClosed = (outcome: "answered" | "no-evidence" | "unreachable") =>
	ticketComments([
		{id: 2, body: composeLaneMarker({map: MAP, ticket: TICKET, nonce: NONCE})},
		{id: 3, body: composeFindingMarker({map: MAP, ticket: TICKET, outcome, nonce: NONCE})},
	]);

/** The body `runRecord` composes for `entry`, or a thrown failure if the fence refuses it. */
const composed = (entry: DecisionEntry, body = MAP_BODY): string => {
	const outcome = applyRecord(parsed(body), TICKET, entry);
	if (outcome._tag === "Refused") throw new Error(`applyRecord refused: ${outcome.reason}`);
	return outcome.body;
};

const recorded = composed({text: ANSWER, authority: {_tag: "Finding", ticket: TICKET}});

describe("runRecord", () => {
	it("exits 1 when --ruled-on arrives without a well-formed --question-id", async () => {
		const out = await run([], {ruledOn: 9301, questionId: "2.3"});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
	});

	it("exits 4 on an empty finding", async () => {
		const out = await run([], {}, {[FINDING]: "\n"});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
	});

	it("exits 21 when the lane returned unreachable — there is no answer to record", async () => {
		const out = await run([
			...frontier(laneClosed("unreachable")),
			[MAP_ISSUE, served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]}))],
		]);
		expect(out.code).toBe(OUTCOME_UNRECORDABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("map descope --ticket");
	});

	it("exits 13 when a forked decision arrives with no --ruled-on", async () => {
		const out = await run([
			...frontier(
				ticketComments(
					[
						{
							id: 2,
							body: composeForkMarker({map: MAP, ticket: TICKET, route: "session", issue: 9301}),
						},
					],
					"decision",
				),
			),
			[MAP_ISSUE, served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]}))],
		]);
		expect(out.code).toBe(TICKET_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("never by restating it");
	});

	it("exits 0 on a research finding, moving the row and closing the ticket in that order", async () => {
		const seams = fakeSeams([
			[PATCH_TICKET, served("{}")],
			[PATCH_MAP, served("{}")],
			...frontier(laneClosed("answered")),
			[
				once(MAP_ISSUE),
				served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, served(issueJson({number: MAP, body: recorded, labels: ["wayfinding:map"]}))],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runRecord(options),
				Layer.merge(seams.layer, fakeFs({files: {[FINDING]: `${ANSWER}\n`}}).layer),
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			map: MAP,
			ticket: TICKET,
			recorded: `— from #${TICKET}`,
			closed: true,
		});
		// The close is second so the surviving half of a partial application is the re-runnable one.
		expect(closeAt(seams)).toBeGreaterThan(mapPatchAt(seams));
	});

	it("moves the answer and the row in ONE body PATCH, so the two cannot separate", async () => {
		const seams = fakeSeams([
			[PATCH_TICKET, served("{}")],
			[PATCH_MAP, served("{}")],
			...frontier(laneClosed("answered")),
			[
				once(MAP_ISSUE),
				served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, served(issueJson({number: MAP, body: recorded, labels: ["wayfinding:map"]}))],
		]);
		await Effect.runPromise(
			Effect.provide(
				runRecord(options),
				Layer.merge(seams.layer, fakeFs({files: {[FINDING]: `${ANSWER}\n`}}).layer),
			),
		);
		const patches = mapPatches(seams);
		expect(patches).toHaveLength(1);
		expect(patches[0]).toContain(`— from #${TICKET}`);
		expect(patches[0]).not.toContain(`- #${TICKET} · research`);
	});

	it("exits 8 naming the ticket when the close does not land — the visible half is the survivor", async () => {
		const out = await run([
			[PATCH_TICKET, {status: 502, body: "{}"}],
			[PATCH_MAP, served("{}")],
			...frontier(laneClosed("answered")),
			[
				once(MAP_ISSUE),
				served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, served(issueJson({number: MAP, body: recorded, labels: ["wayfinding:map"]}))],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain(
			"Re-read the map and re-run with its new digest to resume the close",
		);
	});
});

/** A finding as anyone actually writes one: bold lead-in, blank lines, a numbered list. */
const MULTI_PARAGRAPH = [
	"**The weight column lives on the account row.**",
	"",
	"Three reasons:",
	"",
	"1. the audit log already joins on account id",
	"2. a per-topic column would cost a lookup per moderation action",
	"3. the decay clock is per account, not per topic",
	"",
	"So the column goes on `account`.",
].join("\n");

const FOLDED = MULTI_PARAGRAPH.replace(/\s*\n\s*/g, " ");

describe("a multi-paragraph finding", () => {
	it("is folded to one line, so the body it writes still parses", async () => {
		const folded = composed({text: FOLDED, authority: {_tag: "Finding", ticket: TICKET}});
		const seams = fakeSeams([
			[PATCH_TICKET, served("{}")],
			[PATCH_MAP, served("{}")],
			...frontier(laneClosed("answered")),
			[
				once(MAP_ISSUE),
				served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, served(issueJson({number: MAP, body: folded, labels: ["wayfinding:map"]}))],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runRecord(options),
				Layer.merge(seams.layer, fakeFs({files: {[FINDING]: `${MULTI_PARAGRAPH}\n`}}).layer),
			),
		);
		expect(out.code).toBe(0);
		const landed = parsed(folded);
		expect(landed.decisions).toHaveLength(1);
		expect(landed.decisions[0]?.text).toBe(FOLDED);
		expect(mapPatches(seams)[0] ?? "").toContain(FOLDED);
	});
});

describe("map record and map descope fold free text the same way", () => {
	it("both land one line — a sibling that stopped folding fails here", async () => {
		const folded = composed({text: FOLDED, authority: {_tag: "Finding", ticket: TICKET}});
		const recordSeams = fakeSeams([
			[PATCH_TICKET, served("{}")],
			[PATCH_MAP, served("{}")],
			...frontier(laneClosed("answered")),
			[
				once(MAP_ISSUE),
				served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, served(issueJson({number: MAP, body: folded, labels: ["wayfinding:map"]}))],
		]);
		const fromRecord = await Effect.runPromise(
			Effect.provide(
				runRecord(options),
				Layer.merge(recordSeams.layer, fakeFs({files: {[FINDING]: `${MULTI_PARAGRAPH}\n`}}).layer),
			),
		);

		const direction = "a per-topic weight column";
		const descoped = spliceSection(
			parsed(MAP_BODY),
			"Out of scope",
			renderOutOfScope({
				direction,
				reason: FOLDED.replace(/\.$/, ""),
				recordedAt: "2026-08-10",
			}),
		);
		const descopeSeams = fakeSeams([
			[PATCH_MAP, served("{}")],
			[
				once(MAP_ISSUE),
				served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, served(issueJson({number: MAP, body: descoped, labels: ["wayfinding:map"]}))],
		]);
		const fromDescope = await Effect.runPromise(
			Effect.provide(
				runDescope({
					map: MAP,
					digest: digestFor(MAP_BODY),
					direction,
					reason: FINDING,
					ticket: null,
					repo: null,
					env: {CLAUDE_PIPELINE_REPO: REPO},
					now: () => new Date("2026-08-10T00:00:00Z"),
				}),
				Layer.merge(descopeSeams.layer, fakeFs({files: {[FINDING]: `${MULTI_PARAGRAPH}\n`}}).layer),
			),
		);

		expect([fromRecord.code, fromDescope.code]).toEqual([0, 0]);
		for (const seams of [recordSeams, descopeSeams]) {
			const patch = mapPatches(seams)[0] ?? "";
			expect(patch).toContain(FOLDED.replace(/\.$/, ""));
			expect(patch).not.toContain("1. the audit log already joins on account id\\n");
		}
	});
});

describe("the lockstep is one act: an interrupted run resumes", () => {
	/** The map after the body half landed: the answer recorded, the ticket never closed. */
	const halfDone = (): ReadonlyArray<Scripted> => [
		...frontier(laneClosed("answered")),
		[MAP_ISSUE, served(issueJson({number: MAP, body: recorded, labels: ["wayfinding:map"]}))],
	];

	it("closes the ticket and writes no second entry when the answer is already on the map", async () => {
		const seams = fakeSeams([[PATCH_TICKET, served("{}")], ...halfDone()]);
		const out = await Effect.runPromise(
			Effect.provide(
				runRecord({...options, digest: digestFor(recorded)}),
				Layer.merge(seams.layer, fakeFs({files: {[FINDING]: `${ANSWER}\n`}}).layer),
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			map: MAP,
			ticket: TICKET,
			recorded: `— from #${TICKET}`,
			closed: true,
			resumed: true,
		});
		expect(mapPatches(seams)).toEqual([]);
		expect(seams.bodies.some((body) => body.includes('"state_reason":"completed"'))).toBe(true);
	});

	it("exits 8 when the resumed close still does not land — never 0 with the ticket open", async () => {
		const out = await run([[PATCH_TICKET, {status: 502, body: "{}"}], ...halfDone()], {
			digest: digestFor(recorded),
		});
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain(
			"Re-read the map and re-run with its new digest to resume the close",
		);
	});
});

const SESSION = 9301;
const SESSION_ISSUE = /issues\/9301$/;
const SESSION_COMMENTS = /issues\/9301\/comments/;
const BOUND = roundDigestOf(1);
const QUESTION = "R1.2";

/** The frontier of a map whose one ticket is a decision forked to session #9301. */
const forkedDecision = (): ReadonlyArray<Scripted> =>
	frontier(
		ticketComments(
			[
				{
					id: 2,
					body: composeForkMarker({map: MAP, ticket: TICKET, route: "session", issue: SESSION}),
				},
			],
			"decision",
		),
	);

const mapAt = (body: string): Scripted => [
	MAP_ISSUE,
	served(issueJson({number: MAP, body, labels: ["wayfinding:map"]})),
];

const session = (
	comments: ReadonlyArray<{readonly id: number; readonly body: string}>,
): ReadonlyArray<Scripted> => [
	[SESSION_ISSUE, served(issueJson({number: SESSION, labels: ["grilling:session"]}))],
	[SESSION_COMMENTS, served(commentsJson(comments))],
];

/** Round 1 posted, then R1.2 ruled with its adjacent dated authorization. */
const RULED = [
	{id: 11, body: roundComment(1)},
	{id: 12, body: AUTHORIZATION},
	{id: 13, body: rulingComment(QUESTION, BOUND)},
];

const ruledRecord = composed({
	text: ANSWER,
	authority: {_tag: "Ruled", session: SESSION, questionId: QUESTION},
});

describe("a forked decision ticket's ruling is read through the grill reader", () => {
	it("exits 0 recording the ruling when the cited question reads ruled", async () => {
		const seams = fakeSeams([
			[PATCH_TICKET, served("{}")],
			[PATCH_MAP, served("{}")],
			...forkedDecision(),
			...session(RULED),
			[
				once(MAP_ISSUE),
				served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			mapAt(ruledRecord),
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runRecord({...options, ruledOn: SESSION, questionId: QUESTION}),
				Layer.merge(seams.layer, fakeFs({files: {[FINDING]: `${ANSWER}\n`}}).layer),
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			map: MAP,
			ticket: TICKET,
			recorded: `— ruled on #${SESSION} ${QUESTION}`,
			closed: true,
		});
		expect(closeAt(seams)).toBeGreaterThan(mapPatchAt(seams));
	});

	it("exits 11 when the reader cannot complete its read — never assumed ruled", async () => {
		const out = await run(
			[
				...forkedDecision(),
				mapAt(MAP_BODY),
				[SESSION_ISSUE, served(issueJson({number: SESSION, labels: ["grilling:session"]}))],
				[SESSION_COMMENTS, {status: 403, body: '{"message":"API rate limit exceeded"}'}],
			],
			{ruledOn: SESSION, questionId: QUESTION},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("Nothing was recorded");
	});

	it("exits 7 when the cited session does not exist — an absent session is not an unread one", async () => {
		const out = await run(
			[
				...forkedDecision(),
				mapAt(MAP_BODY),
				[SESSION_ISSUE, {status: 404, body: '{"message":"Not Found"}'}],
			],
			{ruledOn: SESSION, questionId: QUESTION},
		);
		expect(out.code).toBe(NO_TARGET);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("does not exist");
	});

	it("exits 13 when the cited question names nothing in the session", async () => {
		const out = await run([...forkedDecision(), mapAt(MAP_BODY), ...session(RULED)], {
			ruledOn: SESSION,
			questionId: "R9.9",
		});
		expect(out.code).toBe(TICKET_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("names no question");
	});

	it("exits 13 naming the state it read when the question is not ruled", async () => {
		const out = await run(
			[
				...forkedDecision(),
				mapAt(MAP_BODY),
				...session([
					{id: 11, body: roundComment(1)},
					{id: 12, body: answerComment("R1.1", BOUND)},
				]),
			],
			{ruledOn: SESSION, questionId: "R1.1"},
		);
		expect(out.code).toBe(TICKET_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain('reads "answered", not "ruled"');
	});
});

describe("two decision tickets forked to one grilling session", () => {
	/** The map after a SIBLING ticket's R1.1 ruling landed — this ticket's row is still on it. */
	const siblingRecorded = spliceSection(
		parsed(MAP_BODY),
		"Decisions",
		renderDecision({
			text: "the decay clock runs per account",
			authority: {_tag: "Ruled", session: SESSION, questionId: "R1.1"},
		}),
	);

	it("records the second ticket's own answer instead of resuming on the first's", async () => {
		const landed = composed(
			{text: ANSWER, authority: {_tag: "Ruled", session: SESSION, questionId: QUESTION}},
			siblingRecorded,
		);
		const seams = fakeSeams([
			[PATCH_TICKET, served("{}")],
			[PATCH_MAP, served("{}")],
			...forkedDecision(),
			...session(RULED),
			[
				once(MAP_ISSUE),
				served(issueJson({number: MAP, body: siblingRecorded, labels: ["wayfinding:map"]})),
			],
			mapAt(landed),
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runRecord({
					...options,
					digest: digestFor(siblingRecorded),
					ruledOn: SESSION,
					questionId: QUESTION,
				}),
				Layer.merge(seams.layer, fakeFs({files: {[FINDING]: `${ANSWER}\n`}}).layer),
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			recorded: `— ruled on #${SESSION} ${QUESTION}`,
			closed: true,
			resumed: false,
		});
		expect(mapPatches(seams)[0] ?? "").toContain(`${ANSWER} — ruled on #${SESSION} ${QUESTION}`);
		expect(parsed(landed).decisions).toHaveLength(2);
	});

	it("still resumes when the map already carries THIS run's citation", async () => {
		const mine = composed(
			{text: ANSWER, authority: {_tag: "Ruled", session: SESSION, questionId: QUESTION}},
			siblingRecorded,
		);
		const seams = fakeSeams([[PATCH_TICKET, served("{}")], ...forkedDecision(), mapAt(mine)]);
		const out = await Effect.runPromise(
			Effect.provide(
				runRecord({
					...options,
					digest: digestFor(mine),
					ruledOn: SESSION,
					questionId: QUESTION,
				}),
				Layer.merge(seams.layer, fakeFs({files: {[FINDING]: `${ANSWER}\n`}}).layer),
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({resumed: true, closed: true});
		expect(mapPatches(seams)).toEqual([]);
	});
});

describe("a citation on a ticket carrying no fork marker", () => {
	/** An ordinary research ticket's frontier — no fork marker on it. */
	const unforked = (): ReadonlyArray<Scripted> => frontier(ticketComments());

	it("exits 0 recording the ruling when the cited question reads ruled", async () => {
		const seams = fakeSeams([
			[PATCH_TICKET, served("{}")],
			[PATCH_MAP, served("{}")],
			...unforked(),
			...session(RULED),
			[
				once(MAP_ISSUE),
				served(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			mapAt(ruledRecord),
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runRecord({...options, ruledOn: SESSION, questionId: QUESTION}),
				Layer.merge(seams.layer, fakeFs({files: {[FINDING]: `${ANSWER}\n`}}).layer),
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			recorded: `— ruled on #${SESSION} ${QUESTION}`,
			closed: true,
		});
		expect(seams.requests.some((line) => line.includes("issues/9301/comments"))).toBe(true);
	});

	it("exits 13 naming the state it read instead of recording the citation verbatim", async () => {
		const out = await run(
			[
				...unforked(),
				mapAt(MAP_BODY),
				...session([
					{id: 11, body: roundComment(1)},
					{id: 12, body: answerComment("R1.1", BOUND)},
				]),
			],
			{ruledOn: SESSION, questionId: "R1.1"},
		);
		expect(out.code).toBe(TICKET_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain('reads "answered", not "ruled"');
	});

	it("exits 11 when the reader cannot complete its read — never assumed ruled", async () => {
		const out = await run(
			[
				...unforked(),
				mapAt(MAP_BODY),
				[SESSION_ISSUE, served(issueJson({number: SESSION, labels: ["grilling:session"]}))],
				[SESSION_COMMENTS, {status: 403, body: '{"message":"API rate limit exceeded"}'}],
			],
			{ruledOn: SESSION, questionId: QUESTION},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("Nothing was recorded");
	});

	it("exits 7 when the cited session does not exist", async () => {
		const out = await run(
			[
				...unforked(),
				mapAt(MAP_BODY),
				[SESSION_ISSUE, {status: 404, body: '{"message":"Not Found"}'}],
			],
			{ruledOn: SESSION, questionId: QUESTION},
		);
		expect(out.code).toBe(NO_TARGET);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("does not exist");
	});
});
