import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, once, type Scripted} from "../fakes.test-support.ts";
import {read as readRuling} from "../wire/decision-ruling.ts";
import {bodyDigest} from "./digest.ts";
import {
	ADD_LABEL,
	AUTHORIZATION,
	AUTHORIZATION_COMMENT,
	AUTHORIZATION_POSTED,
	AUTHORIZATION_URL,
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
import {type RulingSource, runRule} from "./rule-verb.ts";

type Script = ReadonlyArray<Scripted>;

/** The `--cites` shape, which every case that is not about the quoted one runs under. */
const citing = (cites: string = RULING_URL): RulingSource => ({_tag: "Cited", cites});

/** The `--authorization` shape, with the file already read — the adapter's job, not the verb's. */
const quoting = (text: string = AUTHORIZATION): RulingSource => ({
	_tag: "Quoted",
	authorizationPath: "ruling.md",
	authorization: Effect.succeed({_tag: "Text", text}),
});

const run = (script: Script, ruling: RulingSource = citing(), supersedes: number | null = null) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(
		Effect.provide(
			runRule({number: ISSUE, ruling, supersedes, repo: null, env, now: NOW}),
			seams.layer,
		),
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
			supersedes: null,
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

	/**
	 * The only mechanical statement of contradiction there is: a verb cannot read the ruling's prose
	 * and judge which criterion it overturns, so the human recording it says, and the marker carries
	 * it into the set `review criteria` prints.
	 */
	it("carries the superseded criterion the caller named into the marker", async () => {
		const posted = await run(upToMarker(), citing(), 1);
		expect(postedBody(posted)).toContain("· supersedes:1 ·");
	});

	it("refuses a --supersedes naming no row of the block, before any write", async () => {
		const {outcome, calls} = await run(upToMarker(), citing(), 4);
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.at(-1)).toContain("is not a row of #4300's block, which has 1");
		expect(calls.some((line) => POST.test(line))).toBe(false);
	});

	/**
	 * A founder ruling lands on whatever issue the work is on, and recorded as prose it reaches no
	 * gate. The type fence used to refuse the recording here, which left the ruling unenforceable
	 * everywhere it mattered most.
	 */
	it("records a ruling on an issue that is not a type:decision", async () => {
		const body = await marker();
		const {outcome} = await run([
			[once(ISSUE_READ), issueRead(["type:bug", "ready-for:agent"])],
			[COMMENTS, RULING_ONLY],
			...acl,
			[LABELS, taxonomy],
			[POST, POSTED],
			[GET_MARKER, {status: 200, body: JSON.stringify({body})}],
			[ISSUE_READ, issueRead(["type:bug", "ready-for:agent"])],
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({answer: "ruled", issue: ISSUE});
	});

	/**
	 * The case the widened subject put at risk: `audienceWrites` is unconditional in both
	 * directions, so a flip that widened with the recording would strip a human park off a bug and
	 * hand it to `build claim` as pickable. Fixturing the issue as already `ready-for:agent` would
	 * pass for the wrong reason — `add` is false whenever that label is merely present.
	 */
	it("leaves a type:bug's ready-for:human park exactly as it found it", async () => {
		const parked = ["type:bug", "ready-for:human"];
		const body = await marker();
		const {outcome, calls} = await run([
			[once(ISSUE_READ), issueRead(parked)],
			[COMMENTS, RULING_ONLY],
			...acl,
			[LABELS, taxonomy],
			[POST, POSTED],
			[GET_MARKER, {status: 200, body: JSON.stringify({body})}],
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			answer: "ruled",
			audience: null,
			observed: parked,
		});
		expect(wroteLabels(calls)).toBe(false);
		// No taxonomy read either: that read exists to guard the POST this run never makes.
		expect(calls.some((line) => LABELS.test(line))).toBe(false);
	});

	/**
	 * The criteria guard sits on the flip, so off the decision path there is nothing for it to
	 * guard: the founder's judgement is recorded whatever the bug's body looks like.
	 */
	it("records a ruling on a bug whose body carries no acceptance-criteria block", async () => {
		const body = await marker(BODY_NO_CRITERIA);
		const {outcome, calls} = await run([
			[once(ISSUE_READ), issueRead(["type:bug", "ready-for:human"], BODY_NO_CRITERIA)],
			[COMMENTS, RULING_ONLY],
			...acl,
			[POST, POSTED],
			[GET_MARKER, {status: 200, body: JSON.stringify({body})}],
		]);
		expect(outcome.code).toBe(0);
		expect(wroteLabels(calls)).toBe(false);
	});

	it("refuses a --cites naming another repository or another issue, before any read", async () => {
		const elsewhere = await run(
			upToMarker(),
			citing("https://github.com/other/repo/issues/4300#issuecomment-900001"),
		);
		expect(elsewhere.outcome.code).toBe(1);
		expect(elsewhere.calls).toEqual([]);

		const otherIssue = await run(
			upToMarker(),
			citing("https://github.com/o/r/issues/9999#issuecomment-900001"),
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
			citing(`https://github.com/o/r/issues/${ISSUE}#issuecomment-${RULING_COMMENT + 1}`),
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

/** The bodies of every comment the run posted, in the order it posted them. */
const postedBodies = (posted: {
	calls: ReadonlyArray<string>;
	bodies: ReadonlyArray<string>;
}): ReadonlyArray<string> =>
	posted.calls.flatMap((line, at) => {
		if (!POST.test(line)) return [];
		const sent: unknown = JSON.parse(posted.bodies[at] ?? "{}");
		return typeof sent === "object" && sent !== null && "body" in sent
			? [String((sent as {body: unknown}).body)]
			: [];
	});

describe("runRule --authorization", () => {
	/** Everything up to the marker read-back, with the quote's create answered before the marker's. */
	const upToQuotedMarker = (): Script => [
		[once(ISSUE_READ), issueRead()],
		...acl,
		[LABELS, taxonomy],
		[once(POST), AUTHORIZATION_POSTED],
		[POST, POSTED],
	];

	const quotedMarker = async (): Promise<string> => {
		const bodies = postedBodies(await run(upToQuotedMarker(), quoting()));
		return bodies[1] ?? "";
	};

	it("posts the quote first, then a marker citing it, and flips the audience", async () => {
		const bytes = await quotedMarker();
		const posted = await run(
			[
				...upToQuotedMarker(),
				[GET_MARKER, {status: 200, body: JSON.stringify({body: bytes})}],
				[ADD_LABEL, LABEL_WRITTEN],
				[REMOVE_LABEL, LABEL_WRITTEN],
				[ISSUE_READ, issueRead(["type:decision", "ready-for:agent"])],
			],
			quoting(),
		);
		expect(posted.outcome.code).toBe(0);
		expect(JSON.parse(posted.outcome.stdout)).toMatchObject({
			answer: "ruled",
			ruling: AUTHORIZATION_URL,
			by: RULER,
			comment: MARKER_COMMENT,
			audience: "ready-for:agent",
		});
		const bodies = postedBodies(posted);
		expect(bodies[0]).toBe(AUTHORIZATION);
		expect(readRuling(bodies[1] ?? "")).toMatchObject({
			_tag: "Found",
			value: {issue: ISSUE, digest: bodyDigest(BODY), ruling: AUTHORIZATION_URL},
		});
		expect(posted.outcome.stderr.join("\n")).toContain(`comment ${AUTHORIZATION_COMMENT}`);
		// The founder's own words are the ruling: nothing reads the issue's existing comments for one.
		expect(posted.calls.some((line) => COMMENTS.test(line))).toBe(false);
	});

	it("refuses an undated or empty quote on 21, with nothing read and nothing written", async () => {
		const undated = await run(upToQuotedMarker(), quoting("> take the second fork\n"));
		expect(undated.outcome.code).toBe(21);
		expect(undated.calls).toEqual([]);

		const empty = await run(upToQuotedMarker(), quoting("   \n"));
		expect(empty.outcome.code).toBe(21);
		expect(empty.calls).toEqual([]);
	});

	it("refuses a quote carrying a machine-local path, and one that is a bare @ path", async () => {
		const leaked = await run(
			upToQuotedMarker(),
			quoting("2026-08-19: ruled, see ~/notes/rulings.md\n"),
		);
		expect(leaked.outcome.code).toBe(5);
		expect(leaked.calls).toEqual([]);

		const bare = await run(upToQuotedMarker(), quoting("@~/rulings/2026-08-19.md"));
		expect(bare.outcome.code).toBe(6);
		expect(bare.calls).toEqual([]);
	});

	it("writes no marker when the quote's own write is UNKNOWN", async () => {
		const {outcome, calls} = await run(
			[[POST, {status: 502, body: '{"message":"Bad gateway"}'}], ...upToQuotedMarker()],
			quoting(),
		);
		expect(outcome.code).toBe(8);
		expect(calls.filter((line) => POST.test(line)).length).toBe(1);
		expect(wroteLabels(calls)).toBe(false);
	});

	it("holds the control-plane ACL: an account off the roster posts nothing", async () => {
		const {outcome, calls} = await run(
			[[VIEWER, {status: 200, body: '{"login":"drive-by"}'}], ...upToQuotedMarker()],
			quoting(),
		);
		expect(outcome.code).toBe(20);
		expect(calls.some((line) => POST.test(line))).toBe(false);
	});
});
