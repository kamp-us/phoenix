import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, once, type Scripted} from "../fakes.test-support.ts";
import {read as readRuling} from "../wire/decision-ruling.ts";
import {bodyDigest} from "./digest.ts";
import {
	ADD_LABEL,
	acl,
	BODY,
	BODY_DRIFTED_CRITERIA,
	BODY_NO_CRITERIA,
	CODEOWNERS,
	COMMENTS,
	comments,
	env,
	GET_MARKER,
	ISSUE,
	ISSUE_READ,
	issueRead,
	LABEL_WRITTEN,
	LABELS,
	MARKER_COMMENT,
	MEMBERS,
	NOW,
	POST,
	POSTED,
	REMOVE_LABEL,
	RULER,
	RULING_COMMENT,
	RULING_ONLY,
	RULING_URL,
	taxonomy,
	VIEWER,
} from "./fixtures.test-support.ts";
import {runRule} from "./rule-verb.ts";

type Script = ReadonlyArray<Scripted>;

const run = (script: Script, cites: string = RULING_URL) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(
		Effect.provide(runRule({number: ISSUE, cites, repo: null, env, now: NOW}), seams.layer),
	).then((outcome) => ({outcome, calls: seams.requests, bodies: seams.bodies}));
};

/** The bytes the verb posted — the marker travels as the request body's `body` field now. */
const postedBody = (posted: {
	calls: ReadonlyArray<string>;
	bodies: ReadonlyArray<string>;
}): string => {
	const at = posted.calls.findIndex((line) => POST.test(line));
	if (at < 0) return "";
	const sent: unknown = JSON.parse(posted.bodies[at] ?? "{}");
	return typeof sent === "object" && sent !== null && "body" in sent
		? String((sent as {body: unknown}).body)
		: "";
};

/**
 * Everything up to the marker read-back, for an issue that still carries `ready-for:human`.
 *
 * A function rather than a constant because `once` is spent by the run that matches it: the first
 * issue read answers the pre-write state and the second answers the read-back, and sharing one
 * scripted regex across two runs would leave the second run's first read unscripted.
 */
const upToMarker = (body: string = BODY): Script => [
	[once(ISSUE_READ), issueRead(undefined, body)],
	[COMMENTS, RULING_ONLY],
	...acl,
	[LABELS, taxonomy],
	[POST, POSTED],
];

/** Whether the run touched the audience labels at all — the "nothing was written" assertion. */
const wroteLabels = (calls: ReadonlyArray<string>): boolean =>
	calls.some((line) => ADD_LABEL.test(line) || REMOVE_LABEL.test(line));

/** The marker bytes this fixture's verb composes, taken off a run that stops at the read-back. */
const marker = async (body: string = BODY): Promise<string> =>
	postedBody(await run(upToMarker(body)));

/** A run over `body` carried to a proven marker — the seam where the flip is decided. */
const ruledOn = async (body: string) => {
	const bytes = await marker(body);
	return run([
		...upToMarker(body),
		[GET_MARKER, {status: 200, body: JSON.stringify({body: bytes})}],
	]);
};

/** The whole happy path, with the read-back scripted from the bytes the verb actually posted. */
const settled = async (observed: ReadonlyArray<string> = ["type:decision", "ready-for:agent"]) => {
	const body = await marker();
	return run([
		...upToMarker(),
		[GET_MARKER, {status: 200, body: JSON.stringify({body})}],
		[ADD_LABEL, LABEL_WRITTEN],
		[REMOVE_LABEL, LABEL_WRITTEN],
		[ISSUE_READ, issueRead(observed)],
	]);
};

describe("runRule", () => {
	it("posts a marker bound to the digest it derived itself, then flips the audience", async () => {
		const posted = await settled();
		const {outcome} = posted;
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "ruled",
			issue: ISSUE,
			digest: bodyDigest(BODY),
			ruling: RULING_URL,
			by: RULER,
			at: "2026-08-20T05:11:02Z",
			comment: MARKER_COMMENT,
			audience: "ready-for:agent",
			observed: ["type:decision", "ready-for:agent"],
		});
		expect(readRuling(postedBody(posted))).toMatchObject({
			_tag: "Found",
			value: {issue: ISSUE, digest: bodyDigest(BODY), ruling: RULING_URL},
		});
	});

	it("writes no status: label and touches no issue but the one it was given", async () => {
		const {calls} = await settled();
		const labelWrites = calls.filter((line) => ADD_LABEL.test(line) || REMOVE_LABEL.test(line));
		expect(labelWrites.length).toBeGreaterThan(0);
		expect(labelWrites.join("\n")).not.toContain("status:");
		expect(calls.some((line) => /issues\/(?!4300\b)\d+/.test(line))).toBe(false);
	});

	it("proves the marker before it writes the flip: an unread-back marker leaves the labels alone", async () => {
		const {outcome, calls} = await run([
			...upToMarker(),
			[GET_MARKER, {status: 200, body: JSON.stringify({body: "somebody edited this\n"})}],
		]);
		expect(outcome.code).toBe(9);
		expect(outcome.stdout).toBe("");
		expect(wroteLabels(calls)).toBe(false);
	});

	it("leaves the labels alone when the marker write itself is UNKNOWN", async () => {
		const {outcome, calls} = await run([
			[POST, {status: 502, body: '{"message":"Bad gateway"}'}],
			...upToMarker(),
		]);
		expect(outcome.code).toBe(8);
		expect(wroteLabels(calls)).toBe(false);
	});

	it("exits 11 with nothing written when the roster cannot be read", async () => {
		const {outcome, calls} = await run([
			[MEMBERS, {status: 502, body: '{"message":"Bad gateway"}'}],
			...upToMarker(),
		]);
		expect(outcome.code).toBe(11);
		expect(outcome.stdout).toBe("");
		expect(calls.some((line) => POST.test(line))).toBe(false);
		expect(wroteLabels(calls)).toBe(false);
	});

	it("exits 20 for an account off the roster, and for a roster that names nobody", async () => {
		const offRoster = await run([
			[VIEWER, {status: 200, body: '{"login":"drive-by"}'}],
			...upToMarker(),
		]);
		expect(offRoster.outcome.code).toBe(20);
		expect(offRoster.calls.some((line) => POST.test(line))).toBe(false);

		// Owners CODEOWNERS admits but this group cannot resolve an account against: nobody may rule.
		const empty = await run([
			[CODEOWNERS, {status: 200, body: "/docs/ docs@example.com\n"}],
			...upToMarker(),
		]);
		expect(empty.outcome.code).toBe(20);
		expect(empty.calls.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses an issue that is not a type:decision, before any read of authority", async () => {
		const {outcome, calls} = await run([
			[ISSUE_READ, issueRead(["type:feature", "ready-for:human"])],
			...acl,
		]);
		expect(outcome.code).toBe(7);
		expect(calls.some((line) => VIEWER.test(line))).toBe(false);
	});

	it("refuses a --cites naming another repository or another issue, before any read", async () => {
		const elsewhere = await run(
			upToMarker(),
			"https://github.com/other/repo/issues/4300#issuecomment-900001",
		);
		expect(elsewhere.outcome.code).toBe(1);
		expect(elsewhere.calls).toEqual([]);

		const otherIssue = await run(
			upToMarker(),
			"https://github.com/o/r/issues/9999#issuecomment-900001",
		);
		expect(otherIssue.outcome.code).toBe(1);
		expect(otherIssue.calls).toEqual([]);
	});

	it("refuses a comment id the issue does not carry", async () => {
		const absent = await run([
			[COMMENTS, comments([777, RULER, "some other comment"])],
			...upToMarker(),
		]);
		expect(absent.outcome.code).toBe(7);
		expect(absent.calls.some((line) => POST.test(line))).toBe(false);

		const wrongId = await run(
			upToMarker(),
			`https://github.com/o/r/issues/${ISSUE}#issuecomment-${RULING_COMMENT + 1}`,
		);
		expect(wrongId.outcome.code).toBe(7);
	});

	it("refuses when ready-for:agent is absent from the repository's taxonomy", async () => {
		const {outcome, calls} = await run([
			[LABELS, {status: 200, body: '[{"name":"type:decision"},{"name":"ready-for:human"}]'}],
			...upToMarker(),
		]);
		expect(outcome.code).toBe(7);
		expect(calls.some((line) => POST.test(line))).toBe(false);
	});

	it("reports the flip from the re-read, never from the writes it issued", async () => {
		// Both label writes reported success and the issue still carries the human audience.
		const {outcome} = await settled(["type:decision", "ready-for:agent", "ready-for:human"]);
		expect(outcome.code).toBe(9);
		expect(outcome.stdout).toBe("");
	});

	it("keeps the marker and skips the flip when no acceptance-criteria block is there", async () => {
		const ruled = await ruledOn(BODY_NO_CRITERIA);
		expect(ruled.outcome.code).toBe(4);
		expect(ruled.outcome.stdout).toBe("");
		expect(readRuling(postedBody(ruled))).toMatchObject({
			_tag: "Found",
			value: {issue: ISSUE, digest: bodyDigest(BODY_NO_CRITERIA)},
		});
		expect(wroteLabels(ruled.calls)).toBe(false);
		expect(ruled.calls.some((line) => LABELS.test(line))).toBe(false);
		expect(ruled.outcome.stderr.join("\n")).toContain(`triage enrich ${ISSUE}`);
	});

	it("skips the flip on a drifted heading too, naming the mechanical repair", async () => {
		const ruled = await ruledOn(BODY_DRIFTED_CRITERIA);
		expect(ruled.outcome.code).toBe(4);
		expect(ruled.outcome.stdout).toBe("");
		expect(ruled.calls.some((line) => POST.test(line))).toBe(true);
		expect(wroteLabels(ruled.calls)).toBe(false);
		expect(ruled.outcome.stderr.join("\n")).toContain(`triage repair-criteria ${ISSUE}`);
	});

	it("does not re-add an audience the issue already carries", async () => {
		const already = (): Script => [
			[once(ISSUE_READ), issueRead(["type:decision", "ready-for:agent"])],
			[COMMENTS, RULING_ONLY],
			...acl,
			[POST, POSTED],
		];
		const body = postedBody(await run(already()));
		const {outcome, calls} = await run([
			...already(),
			[GET_MARKER, {status: 200, body: JSON.stringify({body})}],
			[ISSUE_READ, issueRead(["type:decision", "ready-for:agent"])],
		]);
		expect(outcome.code).toBe(0);
		expect(calls.some((line) => ADD_LABEL.test(line))).toBe(false);
		expect(calls.some((line) => LABELS.test(line))).toBe(false);
	});
});
