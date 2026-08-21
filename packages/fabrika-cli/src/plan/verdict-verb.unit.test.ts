import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {comments, LANE_UUID, marker, LANE_TOKEN as TOKEN} from "../build/fixtures.test-support.ts";
import type {HttpReply} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {read as readMarker} from "../wire/verdict-marker.ts";
import {
	BARE_AT_PATH,
	CLAIM_NOT_MINE,
	LEAKED_PATH,
	OFF_VOCABULARY,
	PLAN_MOVED,
	PLAN_UNAPPROVED,
	READBACK_MISMATCH,
} from "./codes.ts";
import {
	approvalRow,
	CHILD as CHILD_AT,
	CWD,
	CYCLE_DOC,
	child,
	childBody,
	cycleDoc,
	digestOver,
	epic,
	epicBody,
	planSeams,
	ROSTER,
	type Scripted,
	SESSION,
	SUB_ISSUES,
	subIssues,
} from "./fixtures.test-support.ts";
import {runVerdict} from "./verdict-verb.ts";

const EPIC = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300$/;
const SUBS = SUB_ISSUES;
const CHILD = CHILD_AT(4301);
const CYCLE = CYCLE_DOC;
const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/4300\/comments\?/;
const PERM = /^GET .*\/repos\/o\/r\/collaborators\/agent\/permission/;
const POST = /^POST .*\/repos\/o\/r\/issues\/4300\/comments$/;
const GET_COMMENT = /^GET .*\/repos\/o\/r\/issues\/comments\/512346$/;

const ONE_CHILD_EPIC = epic({body: epicBody({dependencies: "- phase 1: #4301"})});
const CLEAN_CHILD = child({number: 4301});
const DEFECTIVE_CHILD = child({number: 4301, body: childBody({criteria: "no boxes"})});

const env = {
	CLAUDE_PIPELINE_REPO: "o/r",
	CLAUDE_CODE_SESSION_ID: SESSION,
	GITHUB_TOKEN: "ghp_scripted",
} as Record<string, string | undefined>;

/**
 * The epic's comments as a lane that may post a verdict finds them: this lane's claim marker, and a
 * standing founder approval of the plan the script derives. Both come off **one** read, so the
 * approval has to be a row here rather than a second scripted `COMMENTS` entry nothing would reach.
 */
const claimed = (digest: string): ReadonlyArray<Scripted> => [
	[COMMENTS, comments({id: 1, body: marker(SESSION, LANE_UUID)}, approvalRow(digest))],
	[PERM, {status: 200, body: '{"permission":"write"}'}],
	...ROSTER,
];

const ledger = (childPayload: HttpReply): ReadonlyArray<Scripted> => [
	[EPIC, ONE_CHILD_EPIC],
	[SUBS, subIssues(4301)],
	[CHILD, childPayload],
	[CYCLE, cycleDoc],
];

const POSTED: HttpReply = {
	status: 201,
	body: JSON.stringify({id: 512346, html_url: "https://github.com/o/r/issues/4300#c"}),
};

const digestOf = (childPayload: HttpReply): Promise<string> =>
	digestOver(ledger(childPayload), {env});

const run = (
	digest: string,
	script: ReadonlyArray<Scripted>,
	overrides: {caveats?: string; polarity?: string | null} = {},
) => {
	const seams = planSeams(script);
	const stdin: StdinRead =
		overrides.caveats === undefined
			? {_tag: "NoStdin", reason: "a TTY"}
			: {_tag: "Text", text: overrides.caveats};
	return Effect.runPromise(
		Effect.provide(
			runVerdict({
				number: 4300,
				digest,
				token: TOKEN,
				polarity: overrides.polarity ?? null,
				repo: null,
				env,
				cwd: CWD,
				stdin: Effect.succeed(stdin),
			}),
			seams.layer,
		),
	).then((outcome) => ({outcome, calls: seams.http.calls, bodies: seams.http.bodies}));
};

/** The bytes the verb posted — the marker travels as the request body's `body` field now. */
const postedBody = (run: {calls: ReadonlyArray<string>; bodies: ReadonlyArray<string>}): string => {
	const at = run.calls.findIndex((line) => POST.test(line));
	if (at < 0) return "";
	const sent: unknown = JSON.parse(run.bodies[at] ?? "{}");
	return typeof sent === "object" && sent !== null && "body" in sent
		? String((sent as {body: unknown}).body)
		: "";
};

describe("runVerdict", () => {
	it("posts a PASS bound to the digest and reads it back", async () => {
		const digest = await digestOf(CLEAN_CHILD);
		const first = await run(digest, [...claimed(digest), ...ledger(CLEAN_CHILD), [POST, POSTED]]);
		const body = postedBody(first);
		const {outcome} = await run(digest, [
			...claimed(digest),
			...ledger(CLEAN_CHILD),
			[POST, POSTED],
			[GET_COMMENT, {status: 200, body: JSON.stringify({body})}],
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "posted",
			epic: 4300,
			polarity: "PASS",
			digest,
			skipped: [],
			comment: 512346,
			caveats: 0,
		});
	});

	/**
	 * The load-bearing half of the two `verdict-marker.ts` edits: `read()` gates on the namespace
	 * prefix *before* the regex is ever tested, so widening only the regex leaves the verb emitting a
	 * marker its own read-back guard can never read. Revert either edit and this assertion goes red.
	 */
	it("emits a marker the shared format reads back", async () => {
		const digest = await digestOf(CLEAN_CHILD);
		const posted = await run(digest, [...claimed(digest), ...ledger(CLEAN_CHILD), [POST, POSTED]]);
		const marked = readMarker(postedBody(posted));
		expect(marked._tag).toBe("Found");
		if (marked._tag !== "Found") return;
		expect(marked.value).toMatchObject({
			namespace: "check-epic-plan",
			polarity: "PASS",
			sha: digest,
			clause: "1 children scanned, floor clean",
		});
	});

	it("derives FAIL from the floor and posts it — a defective floor is the deliverable", async () => {
		const digest = await digestOf(DEFECTIVE_CHILD);
		const posted = await run(digest, [
			...claimed(digest),
			...ledger(DEFECTIVE_CHILD),
			[POST, POSTED],
		]);
		const body = postedBody(posted);
		expect(
			body.startsWith(`check-epic-plan: FAIL @ ${digest} — 1 children scanned, floor 1 defect(s)`),
		).toBe(true);
		expect(body).toContain("## Defects");
		expect(body).toContain("- ZERO_AC #4301 — acceptance criteria read as malformed");
	});

	/**
	 * The caller's opinion never becomes the posted verdict: a supplied polarity that contradicts the
	 * derived floor refuses rather than posting either.
	 */
	it("refuses 10 when --polarity disagrees with the derived floor, and posts nothing", async () => {
		const digest = await digestOf(DEFECTIVE_CHILD);
		const {outcome, calls} = await run(
			digest,
			[...claimed(digest), ...ledger(DEFECTIVE_CHILD), [POST, POSTED]],
			{polarity: "PASS"},
		);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toContain("a verdict relays the floor, it does not form one");
		expect(calls.some((line) => POST.test(line))).toBe(false);
	});

	it("accepts a --polarity that agrees", async () => {
		const digest = await digestOf(CLEAN_CHILD);
		const {calls} = await run(
			digest,
			[...claimed(digest), ...ledger(CLEAN_CHILD), [POST, POSTED]],
			{
				polarity: "PASS",
			},
		);
		expect(calls.some((line) => POST.test(line))).toBe(true);
	});

	it("records caveats verbatim under their kinds and counts them", async () => {
		const digest = await digestOf(CLEAN_CHILD);
		const posted = await run(digest, [...claimed(digest), ...ledger(CLEAN_CHILD), [POST, POSTED]], {
			caveats: 'caveat: ac-not-checkable #4301 — "works well" states no observable outcome',
		});
		const body = postedBody(posted);
		expect(body).toContain("### ac-not-checkable");
		expect(body).toContain('- #4301 — "works well" states no observable outcome');
	});

	it("refuses 10 on a caveat kind off the closed set", async () => {
		const digest = await digestOf(CLEAN_CHILD);
		const {outcome, calls} = await run(
			digest,
			[...claimed(digest), ...ledger(CLEAN_CHILD), [POST, POSTED]],
			{
				caveats: "caveat: vibes #4301 — feels thin",
			},
		);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toContain('caveat kind "vibes" is not in the closed set');
		expect(calls.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses 10 on a caveat naming a ref outside the scanned set", async () => {
		const digest = await digestOf(CLEAN_CHILD);
		const {outcome} = await run(
			digest,
			[...claimed(digest), ...ledger(CLEAN_CHILD), [POST, POSTED]],
			{
				caveats: "caveat: brief-fidelity #9999 — drifted",
			},
		);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toContain("which is not in the scanned set");
	});

	/** The caveat tail is model-authored prose reaching a public surface — the seat 5/6 exist for. */
	it("refuses 5 on a machine-local path and 6 on a bare @ reference", async () => {
		const digest = await digestOf(CLEAN_CHILD);
		const leaked = await run(digest, [...claimed(digest), ...ledger(CLEAN_CHILD), [POST, POSTED]], {
			caveats: "caveat: brief-fidelity #4301 — see /Users/someone/notes/plan.md",
		});
		expect(leaked.outcome.code).toBe(LEAKED_PATH);
		expect(leaked.calls.some((line) => POST.test(line))).toBe(false);

		const bare = await run(digest, [...claimed(digest), ...ledger(CLEAN_CHILD), [POST, POSTED]], {
			caveats: "@/Users/someone/notes/plan.md",
		});
		expect(bare.outcome.code).toBe(BARE_AT_PATH);
	});

	it("refuses 21 when the plan moved, and posts nothing", async () => {
		const digest = await digestOf(CLEAN_CHILD);
		const {outcome, calls} = await run("000000000000", [
			...claimed(digest),
			...ledger(CLEAN_CHILD),
			[POST, POSTED],
		]);
		expect(outcome.code).toBe(PLAN_MOVED);
		expect(calls.some((line) => POST.test(line))).toBe(false);
	});

	/** The verb is the only emit path, and it re-reads what it posted. */
	it("refuses 9 when the posted comment does not read back", async () => {
		const digest = await digestOf(CLEAN_CHILD);
		const {outcome} = await run(digest, [
			...claimed(digest),
			...ledger(CLEAN_CHILD),
			[POST, POSTED],
			[GET_COMMENT, {status: 200, body: JSON.stringify({body: "something else entirely"})}],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stdout).toBe("");
	});

	it("refuses 15 when this session does not hold the epic's claim", async () => {
		const {outcome, calls} = await run("4d90e1bb27ac", [
			[EPIC, ONE_CHILD_EPIC],
			[COMMENTS, comments({id: 1, body: marker("another-session", LANE_UUID)})],
			[PERM, {status: 200, body: '{"permission":"write"}'}],
		]);
		expect(outcome.code).toBe(CLAIM_NOT_MINE);
		expect(calls.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses 10 on a malformed --digest before any read", async () => {
		const {outcome, calls} = await run("nothex", []);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(calls).toEqual([]);
	});

	it("treats an unreadable stdin as UNKNOWN, never as zero caveats", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runVerdict({
					number: 4300,
					digest: "4d90e1bb27ac",
					token: TOKEN,
					polarity: null,
					repo: null,
					env,
					cwd: CWD,
					stdin: Effect.succeed<StdinRead>({_tag: "Failed", reason: "EIO"}),
				}),
				planSeams([]).layer,
			),
		);
		expect(outcome.code).toBe(11);
		expect(outcome.stdout).toBe("");
	});

	it("names the skipped classes on the answer and in the marker clause", async () => {
		const script = [
			[EPIC, ONE_CHILD_EPIC],
			[SUBS, subIssues(4301)],
			[CHILD, CLEAN_CHILD],
			[CYCLE, {status: 502, body: '{"message":"Bad gateway"}'}],
		] as ReadonlyArray<Scripted>;
		const digest = await digestOver(script, {env});
		const posted = await run(digest, [...claimed(digest), ...script, [POST, POSTED]]);
		expect(postedBody(posted)).toContain("1 class(es) skipped");
		expect(postedBody(posted)).toContain("## Skipped classes");
	});

	/**
	 * An unapproved plan gets no verdict at all, not even a `FAIL`: a posted verdict is the gate saying
	 * it ran, and on an unapproved plan the gate is exactly what did not run (ADR 0289).
	 */
	it("refuses 25 on an unapproved plan, posting nothing", async () => {
		const digest = await digestOf(DEFECTIVE_CHILD);
		const {outcome, calls} = await run(digest, [
			[COMMENTS, comments({id: 1, body: marker(SESSION, LANE_UUID)})],
			[PERM, {status: 200, body: '{"permission":"write"}'}],
			...ROSTER,
			...ledger(DEFECTIVE_CHILD),
			[POST, POSTED],
		]);
		expect(outcome.code).toBe(PLAN_UNAPPROVED);
		expect(calls.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses 25 on a stale approval, posting nothing", async () => {
		const digest = await digestOf(CLEAN_CHILD);
		const {outcome, calls} = await run(digest, [
			[COMMENTS, comments({id: 1, body: marker(SESSION, LANE_UUID)}, approvalRow("0000000000ff"))],
			[PERM, {status: 200, body: '{"permission":"write"}'}],
			...ROSTER,
			...ledger(CLEAN_CHILD),
			[POST, POSTED],
		]);
		expect(outcome.code).toBe(PLAN_UNAPPROVED);
		expect(outcome.stderr.at(-1)).toContain("state stale");
		expect(calls.some((line) => POST.test(line))).toBe(false);
	});
});
