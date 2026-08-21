import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {Scripted} from "../fakes.test-support.ts";
import type {IssueRecord} from "../io/issues.ts";
import {anySessionCaller, DEFAULT_TTL_MINUTES, laneCaller} from "./claim.ts";
import {COMMENTS, claimPage, EXPIRED, guardedShell, LIVE} from "./claim-fixtures.test-support.ts";
import {CLAIMED_ELSEWHERE, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {foreignMarkers, guardTarget} from "./target-guard.ts";

const MINE = "session-mine";
const THEIRS = "session-theirs";
const LANE = "aaaaaaaa";
const SIBLING = "bbbbbbbb";
/** A token whose nonce is {@link LANE}: the first eight hex digits of the uuid half. */
const TOKEN = `triage:${MINE}:aaaaaaaa-1111-2222-3333-444444444444`;

const target = (over: Partial<IssueRecord> = {}): IssueRecord => ({
	number: 4312,
	title: "t",
	body: "b",
	state: "open",
	labels: [],
	url: "https://example.test/issues/4312",
	author: "agent",
	milestone: null,
	stateReason: null,
	comments: 0,
	isPullRequest: false,
	isSubIssue: false,
	...over,
});

const said = (outcome: {readonly stderr: ReadonlyArray<string>} | null): string =>
	(outcome?.stderr ?? []).join("\n");

const run = (
	script: ReadonlyArray<Scripted>,
	over: {
		readonly state?: "open" | "closed";
		readonly session?: string;
		readonly token?: string;
	} = {},
) =>
	Effect.runPromise(
		Effect.provide(
			guardTarget({
				verb: "triage enrich",
				repo: "o/r",
				issue: 4312,
				target: target(over.state === undefined ? {} : {state: over.state}),
				token: over.token ?? null,
				env:
					over.session === undefined
						? {CLAUDE_PIPELINE_REPO: "o/r"}
						: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: over.session},
			}),
			guardedShell(script).layer,
		),
	);

describe("foreignMarkers", () => {
	const now = Date.parse("2026-08-15T00:00:00Z");
	const scan = (
		markers: ReadonlyArray<{
			readonly id: number;
			readonly session: string;
			readonly lane: string | null;
			readonly createdAt: string;
		}>,
		caller: Parameters<typeof foreignMarkers>[0]["caller"],
	) => foreignMarkers({markers, caller, now, ttlMinutes: DEFAULT_TTL_MINUTES});

	const lane = laneCaller(MINE, LANE, TOKEN);
	const tokenless = anySessionCaller(MINE);

	it("counts a live marker of another session foreign", () => {
		const scanned = scan([{id: 1, session: THEIRS, lane: LANE, createdAt: LIVE}], lane);
		expect(scanned._tag).toBe("Foreign");
		expect(scanned._tag === "Foreign" && scanned.foreign.map((m) => m.session)).toEqual([THEIRS]);
	});

	it("counts this lane's own live marker as not foreign", () => {
		const scanned = scan([{id: 1, session: MINE, lane: LANE, createdAt: LIVE}], lane);
		expect(scanned._tag === "Foreign" && scanned.foreign).toEqual([]);
	});

	it("counts a sibling lane's live marker of this same session foreign", () => {
		const scanned = scan([{id: 1, session: MINE, lane: SIBLING, createdAt: LIVE}], lane);
		expect(scanned._tag === "Foreign" && scanned.foreign.map((m) => m.lane)).toEqual([SIBLING]);
	});

	// A claimant that named a session and nothing else is one no live lane can prove is its own.
	it("counts a pre-#6132 session-only marker foreign to a lane caller", () => {
		const scanned = scan([{id: 1, session: MINE, lane: null, createdAt: LIVE}], lane);
		expect(scanned._tag === "Foreign" && scanned.foreign).toHaveLength(1);
	});

	it("ages an expired sibling marker out", () => {
		const scanned = scan([{id: 1, session: MINE, lane: SIBLING, createdAt: EXPIRED}], lane);
		expect(scanned._tag === "Foreign" && scanned.foreign).toEqual([]);
	});

	it("passes a tokenless caller over one lane of its own session", () => {
		const scanned = scan([{id: 1, session: MINE, lane: LANE, createdAt: LIVE}], tokenless);
		expect(scanned._tag === "Foreign" && scanned.foreign).toEqual([]);
	});

	it("counts every marker foreign to a tokenless caller once two lanes of its session are live", () => {
		const scanned = scan(
			[
				{id: 1, session: MINE, lane: LANE, createdAt: LIVE},
				{id: 2, session: MINE, lane: SIBLING, createdAt: LIVE},
			],
			tokenless,
		);
		expect(scanned._tag === "Foreign" && scanned.foreign).toHaveLength(2);
	});

	// An empty id matches no marker, so a session-blind filter would answer "nobody else holds it"
	// over a set full of live competitors — the one direction this may not fail.
	it("counts every live marker foreign when this session cannot be attributed", () => {
		const scanned = scan(
			[{id: 1, session: MINE, lane: LANE, createdAt: LIVE}],
			anySessionCaller(""),
		);
		expect(scanned._tag === "Foreign" && scanned.foreign).toHaveLength(1);
	});

	it("refuses to resolve a marker whose ordering key will not parse", () => {
		const scanned = scan([{id: 1, session: THEIRS, lane: LANE, createdAt: "whenever"}], lane);
		expect(scanned._tag).toBe("Unresolvable");
	});
});

describe("guardTarget", () => {
	it("passes an open, unclaimed issue", async () => {
		expect(await run([])).toBeNull();
	});

	it("refuses a closed issue on 7, before reading any comment", async () => {
		const shell = guardedShell([]);
		const outcome = await Effect.runPromise(
			Effect.provide(
				guardTarget({
					verb: "triage enrich",
					repo: "o/r",
					issue: 4312,
					target: target({state: "closed"}),
					env: {CLAUDE_PIPELINE_REPO: "o/r"},
				}),
				shell.layer,
			),
		);
		expect(outcome?.code).toBe(ZERO_SCOPE);
		expect(shell.requests).toEqual([]);
	});

	it("names the target by the caller's noun", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				guardTarget({
					verb: "triage split",
					repo: "o/r",
					issue: 4312,
					target: target({state: "closed"}),
					noun: "parent",
					env: {CLAUDE_PIPELINE_REPO: "o/r"},
				}),
				guardedShell([]).layer,
			),
		);
		expect(said(outcome)).toContain("triage split: parent #4312 is already closed.");
	});

	it("refuses a live foreign claim on 17, naming the holder", async () => {
		const outcome = await run([[COMMENTS, claimPage({session: THEIRS, createdAt: LIVE})]], {
			session: MINE,
		});
		expect(outcome?.code).toBe(CLAIMED_ELSEWHERE);
		expect(said(outcome)).toContain(THEIRS);
	});

	it("passes when the live claim is this lane's own", async () => {
		expect(
			await run([[COMMENTS, claimPage({session: MINE, createdAt: LIVE, lane: LANE})]], {
				session: MINE,
				token: TOKEN,
			}),
		).toBeNull();
	});

	it("refuses a sibling lane of this session on 17, before any write", async () => {
		const outcome = await run(
			[[COMMENTS, claimPage({session: MINE, createdAt: LIVE, lane: SIBLING})]],
			{
				session: MINE,
				token: TOKEN,
			},
		);
		expect(outcome?.code).toBe(CLAIMED_ELSEWHERE);
		expect(said(outcome)).toContain(`claimed by lane ${SIBLING} of this session`);
	});

	it("refuses a tokenless call on 17 once two lanes of its session hold live markers", async () => {
		const outcome = await run(
			[
				[
					COMMENTS,
					claimPage(
						{session: MINE, createdAt: LIVE, lane: LANE},
						{session: MINE, createdAt: LIVE, lane: SIBLING},
					),
				],
			],
			{session: MINE},
		);
		expect(outcome?.code).toBe(CLAIMED_ELSEWHERE);
		expect(said(outcome)).toContain("this call names none");
	});

	it("passes a tokenless call over one lane of its session — the uncontested call sites", async () => {
		expect(
			await run([[COMMENTS, claimPage({session: MINE, createdAt: LIVE, lane: LANE})]], {
				session: MINE,
			}),
		).toBeNull();
	});

	it("refuses on 1 when --token names a session other than the one running", async () => {
		const outcome = await run([], {session: MINE, token: `triage:${THEIRS}:aaaaaaaa-1-2-3-4`});
		expect(outcome?.code).toBe(1);
		expect(said(outcome)).toContain("a lane names itself, never another");
	});

	it("passes an expired foreign claim — the TTL still ages markers out", async () => {
		expect(
			await run([[COMMENTS, claimPage({session: THEIRS, createdAt: EXPIRED})]], {session: MINE}),
		).toBeNull();
	});

	it("refuses on 11 when the comment read fails — never a pass", async () => {
		const outcome = await run([[COMMENTS, {status: 502, body: "{}"}]], {session: MINE});
		expect(outcome?.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses on 11 when a marker's ordering key will not parse", async () => {
		const outcome = await run([[COMMENTS, claimPage({session: THEIRS, createdAt: "whenever"})]], {
			session: MINE,
		});
		expect(outcome?.code).toBe(PRECONDITION_UNKNOWN);
	});
});
