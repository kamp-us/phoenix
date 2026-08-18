import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, type okOut} from "../fakes.test-support.ts";
import type {IssueRecord} from "../io/issues.ts";
import {DEFAULT_TTL_MINUTES} from "./claim.ts";
import {COMMENTS, claimPage, EXPIRED, guardedShell, LIVE} from "./claim-fixtures.test-support.ts";
import {CLAIMED_ELSEWHERE, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {foreignMarkers, guardTarget} from "./target-guard.ts";

const MINE = "session-mine";
const THEIRS = "session-theirs";

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
	...over,
});

const said = (outcome: {readonly stderr: ReadonlyArray<string>} | null): string =>
	(outcome?.stderr ?? []).join("\n");

const run = (
	script: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]>,
	over: {readonly state?: "open" | "closed"; readonly session?: string} = {},
) =>
	Effect.runPromise(
		Effect.provide(
			guardTarget({
				verb: "triage enrich",
				repo: "o/r",
				issue: 4312,
				target: target(over.state === undefined ? {} : {state: over.state}),
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
			readonly createdAt: string;
		}>,
		session: string,
	) => foreignMarkers({markers, session, now, ttlMinutes: DEFAULT_TTL_MINUTES});

	it("counts a live marker of another session foreign", () => {
		const scanned = scan([{id: 1, session: THEIRS, createdAt: LIVE}], MINE);
		expect(scanned._tag).toBe("Foreign");
		expect(scanned._tag === "Foreign" && scanned.foreign.map((m) => m.session)).toEqual([THEIRS]);
	});

	it("counts this session's own live marker as not foreign", () => {
		const scanned = scan([{id: 1, session: MINE, createdAt: LIVE}], MINE);
		expect(scanned._tag === "Foreign" && scanned.foreign).toEqual([]);
	});

	it("ages an expired foreign marker out", () => {
		const scanned = scan([{id: 1, session: THEIRS, createdAt: EXPIRED}], MINE);
		expect(scanned._tag === "Foreign" && scanned.foreign).toEqual([]);
	});

	// An empty id matches no marker, so a session-blind filter would answer "nobody else holds it"
	// over a set full of live competitors — the one direction this may not fail.
	it("counts every live marker foreign when this session cannot be attributed", () => {
		const scanned = scan([{id: 1, session: MINE, createdAt: LIVE}], "");
		expect(scanned._tag === "Foreign" && scanned.foreign).toHaveLength(1);
	});

	it("refuses to resolve a marker whose ordering key will not parse", () => {
		const scanned = scan([{id: 1, session: THEIRS, createdAt: "whenever"}], MINE);
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
		expect(shell.calls).toEqual([]);
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

	it("passes when the live claim is this session's own", async () => {
		expect(
			await run([[COMMENTS, claimPage({session: MINE, createdAt: LIVE})]], {session: MINE}),
		).toBeNull();
	});

	it("passes an expired foreign claim — the TTL still ages markers out", async () => {
		expect(
			await run([[COMMENTS, claimPage({session: THEIRS, createdAt: EXPIRED})]], {session: MINE}),
		).toBeNull();
	});

	it("refuses on 11 when the comment read fails — never a pass", async () => {
		const outcome = await run([[COMMENTS, errOut("gh: Bad gateway (HTTP 502)")]], {session: MINE});
		expect(outcome?.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses on 11 when a marker's ordering key will not parse", async () => {
		const outcome = await run([[COMMENTS, claimPage({session: THEIRS, createdAt: "whenever"})]], {
			session: MINE,
		});
		expect(outcome?.code).toBe(PRECONDITION_UNKNOWN);
	});
});
