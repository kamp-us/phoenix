import {assert, describe, it} from "@effect/vitest";
import {
	bindsSameHead,
	boundHeadShas,
	emissionDefect,
	headBindingDefect,
	isBoundToHead,
	isNamespaceMarker,
	isReviewed,
	isUnboundPolarityMarker,
	malformedEmittedSha,
	normalizeRunId,
	outcomeReason,
	parseVerdict,
	resolveVerdict,
	runIdOf,
	toStampIso,
	type VerdictComment,
	type VerdictGate,
	type VerdictOutcome,
	type VerdictState,
	verdictState,
	withRunId,
	withWrittenAt,
	writeRecencyOf,
	writtenAtOf,
} from "./verdict-match.ts";

const HEAD = "abc1234def5678";
const OLD = "0000000aaaa1111";

const marker = (over: Partial<VerdictComment> & {readonly id: number}): VerdictComment => ({
	author: "usirin",
	createdAt: "2026-07-11T00:00:00Z",
	body: `review-doc: PASS @ ${HEAD} — merge-ready`,
	...over,
});

describe("parseVerdict — polarity + bound SHA out of a first-line marker", () => {
	const cases: ReadonlyArray<{
		readonly name: string;
		readonly body: string;
		readonly gate: VerdictGate;
		readonly expected: ReturnType<typeof parseVerdict>;
	}> = [
		{
			name: "bindable PASS captures polarity + sha",
			body: `review-doc: PASS @ ${HEAD} — merge-ready`,
			gate: "doc",
			expected: {polarity: "PASS", sha: HEAD},
		},
		{
			name: "bindable FAIL captures polarity + sha",
			body: `review-code: FAIL @ ${HEAD} — not merge-ready`,
			gate: "code",
			expected: {polarity: "FAIL", sha: HEAD},
		},
		{
			name: "leading bold emphasis is tolerated (§5 \\**)",
			body: `**review-skill: PASS @ ${HEAD}** — merge-ready`,
			gate: "skill",
			expected: {polarity: "PASS", sha: HEAD},
		},
		{
			name: "SHA-less PASS marker → sha null (legacy/pre-0058)",
			body: "review-doc: PASS — merge-ready",
			gate: "doc",
			expected: {polarity: "PASS", sha: null},
		},
		{
			name: "advisory line is NOT a PASS/FAIL verdict → null",
			body: "review-doc: advisory — blocking-set PR (manual merge)",
			gate: "doc",
			expected: null,
		},
		{
			name: "another gate's marker does not match this namespace",
			body: `review-code: PASS @ ${HEAD} — merge-ready`,
			gate: "doc",
			expected: null,
		},
		{
			name: "a mid-body quote does not match (anchored to first line)",
			body: `discussing the review-doc: PASS @ ${HEAD} marker`,
			gate: "doc",
			expected: null,
		},
		{
			name: "trailing @sha after the em-dash tail does NOT bind (fixed token order, #625)",
			body: `review-doc: PASS — merge-ready @ ${HEAD}`,
			gate: "doc",
			expected: {polarity: "PASS", sha: null},
		},
	];
	for (const {name, body, gate, expected} of cases) {
		it(name, () => assert.deepStrictEqual(parseVerdict(body, gate), expected));
	}
});

describe("isBoundToHead — SHA-staleness prefix-match, fail-closed on empty", () => {
	it("exact match is current", () => assert.isTrue(isBoundToHead(HEAD, HEAD)));
	it("abbreviated verdict SHA prefixes the full head", () =>
		assert.isTrue(isBoundToHead("abc1234", HEAD)));
	it("full verdict SHA is prefixed by an abbreviated head", () =>
		assert.isTrue(isBoundToHead(HEAD, "abc1234")));
	it("case-insensitive", () => assert.isTrue(isBoundToHead(HEAD.toUpperCase(), HEAD)));
	it("a different head is not current", () => assert.isFalse(isBoundToHead(OLD, HEAD)));
	it("null bound SHA is never current (legacy marker fail-closed)", () =>
		assert.isFalse(isBoundToHead(null, HEAD)));
	it("empty head is never current (the unguarded-glob bug, ADR 0058 rule 3)", () =>
		assert.isFalse(isBoundToHead(HEAD, "")));
});

describe("resolveVerdict — the SHA-bound verdict decision (table-driven, ADR 0058 rule 3)", () => {
	const cases: ReadonlyArray<{
		readonly name: string;
		readonly comments: ReadonlyArray<VerdictComment>;
		readonly authorized: ReadonlyArray<string>;
		readonly gate: VerdictGate;
		readonly head: string;
		readonly expected: VerdictOutcome;
		readonly reviewedPass: boolean;
	}> = [
		{
			name: "matching @sha PASS → current PASS (reviewed)",
			comments: [marker({id: 1})],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "current", commentId: 1, polarity: "PASS", sha: HEAD},
			reviewedPass: true,
		},
		{
			name: "SHA-less advisory PASS does NOT satisfy the SHA-bound check",
			comments: [marker({id: 1, body: "review-doc: PASS — merge-ready"})],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "sha-less", commentId: 1, polarity: "PASS"},
			reviewedPass: false,
		},
		{
			name: "a verdict bound to a stale sha does NOT pass",
			comments: [marker({id: 1, body: `review-doc: PASS @ ${OLD} — merge-ready`})],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "stale", commentId: 1, polarity: "PASS", sha: OLD},
			reviewedPass: false,
		},
		{
			name: "newest matching verdict wins when several exist (FAIL after PASS → not reviewed)",
			comments: [
				marker({
					id: 1,
					createdAt: "2026-07-11T00:00:00Z",
					body: `review-doc: PASS @ ${HEAD} — merge-ready`,
				}),
				marker({
					id: 2,
					createdAt: "2026-07-11T00:00:05Z",
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
			],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "current", commentId: 2, polarity: "FAIL", sha: HEAD},
			reviewedPass: false,
		},
		{
			name: "newest matching verdict wins (PASS after FAIL → reviewed)",
			comments: [
				marker({
					id: 2,
					createdAt: "2026-07-11T00:00:05Z",
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
				marker({
					id: 1,
					createdAt: "2026-07-11T00:00:00Z",
					body: `review-doc: PASS @ ${OLD} — merge-ready`,
				}),
			],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "current", commentId: 2, polarity: "FAIL", sha: HEAD},
			reviewedPass: false,
		},
		{
			name: "equal createdAt → newest by the larger comment id",
			comments: [
				marker({
					id: 10,
					createdAt: "2026-07-11T00:00:00Z",
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
				marker({
					id: 20,
					createdAt: "2026-07-11T00:00:00Z",
					body: `review-doc: PASS @ ${HEAD} — merge-ready`,
				}),
			],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "current", commentId: 20, polarity: "PASS", sha: HEAD},
			reviewedPass: true,
		},
		// The run-scoped upsert (#4016) means two reviewer RUNS can now leave two verdict comments
		// at ONE head, where the author-keyed upsert used to collapse them to one. Resolution is
		// unchanged by that: latest-wins still decides (ADR 0058) — the newer verdict supersedes the
		// older, exactly as a re-review at the same head always did. (Unstamped bodies like these fall
		// back to `createdAt`; #4200 covers the case where an upsert makes the two diverge.)
		{
			name: "two runs at one head: the newer verdict supersedes the older (latest-wins)",
			comments: [
				marker({
					id: 1,
					createdAt: "2026-07-11T00:00:00Z",
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
				marker({
					id: 2,
					createdAt: "2026-07-11T00:00:05Z",
					body: `review-doc: PASS @ ${HEAD} — merge-ready`,
				}),
			],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "current", commentId: 2, polarity: "PASS", sha: HEAD},
			reviewedPass: true,
		},
		{
			name: "a forged PASS from a non-collaborator is dropped (author-gate, ADR 0055)",
			comments: [
				marker({
					id: 1,
					author: "attacker",
					createdAt: "2026-07-11T00:00:09Z",
					body: `review-doc: PASS @ ${HEAD} — merge-ready`,
				}),
				marker({
					id: 2,
					author: "usirin",
					createdAt: "2026-07-11T00:00:00Z",
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
			],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "current", commentId: 2, polarity: "FAIL", sha: HEAD},
			reviewedPass: false,
		},
		{
			name: "empty authorized set → none (fail-closed, never a false win)",
			comments: [marker({id: 1})],
			authorized: [],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "none"},
			reviewedPass: false,
		},
		{
			name: "no marker in the namespace → none",
			comments: [marker({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`})],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "none"},
			reviewedPass: false,
		},
		{
			name: "an advisory-only namespace → none (advisory is not a machine PASS)",
			comments: [marker({id: 1, body: "review-doc: advisory — blocking-set PR (manual merge)"})],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "none"},
			reviewedPass: false,
		},
	];
	for (const {name, comments, authorized, gate, head, expected, reviewedPass} of cases) {
		it(name, () => {
			const outcome = resolveVerdict({
				comments,
				authorizedAuthors: authorized,
				gate,
				headSha: head,
			});
			assert.deepStrictEqual(outcome, expected);
			assert.strictEqual(isReviewed(outcome, "PASS"), reviewedPass);
		});
	}

	it("cross-namespace isolation: the same PASS resolves per gate", () => {
		const comments = [
			marker({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`}),
			marker({id: 2, body: `review-skill: FAIL @ ${HEAD} — changes-requested`}),
		];
		assert.deepStrictEqual(
			resolveVerdict({comments, authorizedAuthors: ["usirin"], gate: "code", headSha: HEAD}),
			{_tag: "current", commentId: 1, polarity: "PASS", sha: HEAD},
		);
		assert.deepStrictEqual(
			resolveVerdict({comments, authorizedAuthors: ["usirin"], gate: "skill", headSha: HEAD}),
			{_tag: "current", commentId: 2, polarity: "FAIL", sha: HEAD},
		);
		assert.deepStrictEqual(
			resolveVerdict({comments, authorizedAuthors: ["usirin"], gate: "doc", headSha: HEAD}),
			{_tag: "none"},
		);
	});
});

describe("resolveVerdict — live-head candidates first, latest-wins only among them (#4189)", () => {
	// The fixture shape is PR #3955's, and its creation order is the INVERSE of its head-binding
	// order: the live-head verdict was upserted in place (#4016/#4050) into a slot created at 00:09,
	// while the dead-head verdict was created fresh at 00:32. A `(createdAt, id)` pick crowns the
	// 00:32 comment, applies the head test to that winner alone, and refuses a green PR.
	const atHead = (over: Partial<VerdictComment> & {readonly id: number}) =>
		marker({
			createdAt: "2026-07-26T00:09:45Z",
			body: `review-doc: PASS @ ${HEAD} — merge-ready`,
			...over,
		});
	const atDeadHead = (over: Partial<VerdictComment> & {readonly id: number}) =>
		marker({
			createdAt: "2026-07-26T00:32:02Z",
			body: `review-doc: FAIL @ ${OLD} — changes-requested`,
			...over,
		});

	const cases: ReadonlyArray<{
		readonly name: string;
		readonly comments: ReadonlyArray<VerdictComment>;
		readonly authorized: ReadonlyArray<string>;
		readonly expected: VerdictOutcome;
	}> = [
		{
			name: "a newer-created dead-head FAIL does not shadow an older-created live-head PASS",
			comments: [atHead({id: 1}), atDeadHead({id: 2})],
			authorized: ["usirin"],
			expected: {_tag: "current", commentId: 1, polarity: "PASS", sha: HEAD},
		},
		{
			name: "the same reordering in the FAIL direction: a newer-created dead-head PASS never clears a live-head FAIL",
			comments: [
				atHead({id: 1, body: `review-doc: FAIL @ ${HEAD} — changes-requested`}),
				atDeadHead({id: 2, body: `review-doc: PASS @ ${OLD} — merge-ready`}),
			],
			authorized: ["usirin"],
			expected: {_tag: "current", commentId: 1, polarity: "FAIL", sha: HEAD},
		},
		{
			name: "within the live-head set latest-wins still arbitrates (#4016's two surviving runs)",
			comments: [
				atHead({id: 1}),
				atHead({
					id: 2,
					createdAt: "2026-07-26T00:10:00Z",
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
				atDeadHead({id: 3}),
			],
			authorized: ["usirin"],
			expected: {_tag: "current", commentId: 2, polarity: "FAIL", sha: HEAD},
		},
		{
			name: "NOTHING binds the live head ⇒ unchanged fail-closed stale refusal, naming the newest",
			comments: [
				atDeadHead({id: 1, createdAt: "2026-07-26T00:20:00Z"}),
				atDeadHead({id: 2, body: `review-doc: PASS @ ${OLD} — merge-ready`}),
			],
			authorized: ["usirin"],
			expected: {_tag: "stale", commentId: 2, polarity: "PASS", sha: OLD},
		},
		{
			name: "a forged live-head PASS cannot win the head-first filter (ADR 0055 gate composes)",
			comments: [atHead({id: 1, author: "attacker"}), atDeadHead({id: 2})],
			authorized: ["usirin"],
			expected: {_tag: "stale", commentId: 2, polarity: "FAIL", sha: OLD},
		},
		{
			name: "a SHA-less legacy marker binds no head, so a live-head verdict outranks it however new",
			comments: [
				atHead({id: 1}),
				marker({id: 2, createdAt: "2026-07-26T00:40:00Z", body: "review-doc: FAIL — legacy"}),
			],
			authorized: ["usirin"],
			expected: {_tag: "current", commentId: 1, polarity: "PASS", sha: HEAD},
		},
	];
	for (const {name, comments, authorized, expected} of cases) {
		it(name, () =>
			assert.deepStrictEqual(
				resolveVerdict({comments, authorizedAuthors: authorized, gate: "doc", headSha: HEAD}),
				expected,
			),
		);
	}
});

describe("resolveVerdict — two LIVE-HEAD verdicts order by write time, not slot-open time (#4200)", () => {
	// The residual #4198's head-first filter structurally cannot close: BOTH candidates bind the live
	// head, so both survive the filter and the tiebreak among them decides alone — with no staleness
	// backstop to convert a mis-pick into a refusal. `post` upserts in place at the same head, so the
	// corrected verdict keeps the `created_at` of the slot it was PATCHed into: creation order is the
	// INVERSE of write order here.
	const SLOT_OPENED = "2026-07-26T00:09:58Z"; // the upserted slot, opened first
	const UPSERTED_AT = "2026-07-26T00:49:26Z"; // …but rewritten LAST
	const SIBLING_CREATED = "2026-07-26T00:32:02Z"; // a sibling run's fresh comment, in between

	const stamped = (first: string, writtenAt: string) => `${first}\n\nVerdict-written: ${writtenAt}`;

	const cases: ReadonlyArray<{
		readonly name: string;
		readonly comments: ReadonlyArray<VerdictComment>;
		readonly expected: VerdictOutcome;
	}> = [
		{
			// The direction with NO backstop: a live FAIL upserted after a live PASS. Ordering by
			// `created_at` reports `pass` and clears the merge gate over a standing FAIL.
			name: "FALSE CLEARANCE: an older slot upserted to FAIL beats a newer-created same-head PASS",
			comments: [
				marker({
					id: 1,
					createdAt: SLOT_OPENED,
					body: stamped(`review-doc: FAIL @ ${HEAD} — changes-requested`, UPSERTED_AT),
				}),
				marker({
					id: 2,
					createdAt: SIBLING_CREATED,
					body: stamped(`review-doc: PASS @ ${HEAD} — merge-ready`, SIBLING_CREATED),
				}),
			],
			expected: {_tag: "current", commentId: 1, polarity: "FAIL", sha: HEAD},
		},
		{
			name: "FALSE REFUSAL: an older slot upserted to PASS beats a newer-created same-head FAIL",
			comments: [
				marker({
					id: 1,
					createdAt: SLOT_OPENED,
					body: stamped(`review-doc: PASS @ ${HEAD} — merge-ready`, UPSERTED_AT),
				}),
				marker({
					id: 2,
					createdAt: SIBLING_CREATED,
					body: stamped(`review-doc: FAIL @ ${HEAD} — changes-requested`, SIBLING_CREATED),
				}),
			],
			expected: {_tag: "current", commentId: 1, polarity: "PASS", sha: HEAD},
		},
		{
			// Write order AGREEING with creation order must not regress: #4016/#4050's run-keyed upsert
			// leaves two same-head verdicts to arbitrate, and the ordinary case is still latest-wins.
			name: "write order agreeing with creation order is unchanged latest-wins (#4016 preserved)",
			comments: [
				marker({
					id: 1,
					createdAt: SLOT_OPENED,
					body: stamped(`review-doc: PASS @ ${HEAD} — merge-ready`, SLOT_OPENED),
				}),
				marker({
					id: 2,
					createdAt: SIBLING_CREATED,
					body: stamped(`review-doc: FAIL @ ${HEAD} — changes-requested`, SIBLING_CREATED),
				}),
			],
			expected: {_tag: "current", commentId: 2, polarity: "FAIL", sha: HEAD},
		},
		{
			// The floor: a stamp can never pull a verdict BELOW its own slot-open time, so a backdated
			// (or absent) stamp degrades to today's `created_at` ordering rather than to something worse.
			name: "a backdated stamp is floored at created_at — it cannot demote a genuinely newer comment",
			comments: [
				marker({
					id: 1,
					createdAt: SLOT_OPENED,
					body: stamped(`review-doc: PASS @ ${HEAD} — merge-ready`, "2020-01-01T00:00:00Z"),
				}),
				marker({
					id: 2,
					createdAt: SIBLING_CREATED,
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
			],
			expected: {_tag: "current", commentId: 2, polarity: "FAIL", sha: HEAD},
		},
		{
			name: "a stamped verdict still loses to an unstamped one created later (mixed pre/post-#4200)",
			comments: [
				marker({
					id: 1,
					createdAt: SLOT_OPENED,
					body: stamped(`review-doc: PASS @ ${HEAD} — merge-ready`, "2026-07-26T00:20:00Z"),
				}),
				marker({
					id: 2,
					createdAt: "2026-07-26T00:40:00Z",
					body: `review-doc: FAIL @ ${HEAD} — changes-requested`,
				}),
			],
			expected: {_tag: "current", commentId: 2, polarity: "FAIL", sha: HEAD},
		},
		{
			// The head-first filter still runs FIRST: write recency only ever orders WITHIN the live-head
			// set, so a freshly-written stale verdict cannot climb back over a live-head one (#4189).
			name: "a newly-written DEAD-head verdict still loses to the live-head one (#4189 preserved)",
			comments: [
				marker({
					id: 1,
					createdAt: SLOT_OPENED,
					body: stamped(`review-doc: PASS @ ${HEAD} — merge-ready`, SLOT_OPENED),
				}),
				marker({
					id: 2,
					createdAt: SIBLING_CREATED,
					body: stamped(`review-doc: FAIL @ ${OLD} — changes-requested`, "2026-07-26T23:00:00Z"),
				}),
			],
			expected: {_tag: "current", commentId: 1, polarity: "PASS", sha: HEAD},
		},
	];
	for (const {name, comments, expected} of cases) {
		it(name, () =>
			assert.deepStrictEqual(
				resolveVerdict({comments, authorizedAuthors: ["usirin"], gate: "doc", headSha: HEAD}),
				expected,
			),
		);
	}
});

describe("the write-recency stamp — the ordering key an in-place upsert can move (#4200)", () => {
	const SHA40 = "a".repeat(40);
	const BODY = `review-doc: PASS @ ${SHA40} — merge-ready`;
	const T1 = "2026-07-26T00:09:58Z";
	const T2 = "2026-07-26T00:49:26Z";

	it("writtenAtOf reads back the stamp withWrittenAt wrote", () =>
		assert.strictEqual(writtenAtOf(withWrittenAt(BODY, T1)), T1));

	it("writtenAtOf is null for an unstamped (pre-#4200 / hand-rolled) body", () =>
		assert.isNull(writtenAtOf(BODY)));

	it("withWrittenAt replaces the prior stamp rather than stacking a second", () => {
		const restamped = withWrittenAt(withWrittenAt(BODY, T1), T2);
		assert.strictEqual(writtenAtOf(restamped), T2);
		assert.strictEqual(restamped.split("Verdict-written:").length - 1, 1);
	});

	it("a stamp quoted in the body's PROSE never outranks the real appended one", () =>
		assert.strictEqual(
			writtenAtOf(withWrittenAt(`${BODY}\n\nthe prior run stamped Verdict-written: ${T1}`, T2)),
			T2,
		));

	it("a stamped body still passes every emission guard (marker stays on line one)", () =>
		assert.isNull(emissionDefect(withWrittenAt(BODY, T1), "doc")));

	it("the stamp composes with the run trailer, both readable", () => {
		const both = withRunId(withWrittenAt(BODY, T1), "ddf8f459-b75f-4de2-9051-8df10da5b55c");
		assert.strictEqual(writtenAtOf(both), T1);
		assert.strictEqual(runIdOf(both), "ddf8f459-b75f-4de2-9051-8df10da5b55c");
		assert.isNull(emissionDefect(both, "doc"));
	});

	it("writeRecencyOf floors the stamp at created_at (an absent/backdated stamp never demotes)", () => {
		assert.strictEqual(writeRecencyOf(marker({id: 1, createdAt: T1, body: BODY})), T1);
		assert.strictEqual(
			writeRecencyOf(marker({id: 1, createdAt: T1, body: withWrittenAt(BODY, T2)})),
			T2,
		);
		assert.strictEqual(
			writeRecencyOf(marker({id: 1, createdAt: T2, body: withWrittenAt(BODY, T1)})),
			T2,
		);
	});

	it("toStampIso drops milliseconds so a stamp is lexically comparable with a created_at", () => {
		const iso = toStampIso(Date.parse("2026-07-26T00:49:26.123Z"));
		assert.strictEqual(iso, "2026-07-26T00:49:26Z");
		// the inversion the truncation exists to prevent: `.` sorts BELOW `Z`
		assert.isTrue("2026-07-26T00:49:26.123Z" < "2026-07-26T00:49:26Z");
		assert.isFalse(iso < "2026-07-26T00:49:26Z");
	});
});

describe("isReviewed — read-verb decision over expected polarity", () => {
	it("current FAIL satisfies an expect-FAIL read (write-code repair seam)", () => {
		const outcome: VerdictOutcome = {_tag: "current", commentId: 1, polarity: "FAIL", sha: HEAD};
		assert.isTrue(isReviewed(outcome, "FAIL"));
		assert.isFalse(isReviewed(outcome, "PASS"));
	});
	it("a stale verdict never satisfies either polarity", () => {
		const outcome: VerdictOutcome = {_tag: "stale", commentId: 1, polarity: "PASS", sha: OLD};
		assert.isFalse(isReviewed(outcome, "PASS"));
		assert.isFalse(isReviewed(outcome, "FAIL"));
	});
});

describe("isNamespaceMarker — the post cross-namespace guard", () => {
	it("accepts this gate's PASS marker", () =>
		assert.isTrue(isNamespaceMarker(`review-doc: PASS @ ${HEAD} — merge-ready`, "doc")));
	it("accepts this gate's advisory line", () =>
		assert.isTrue(
			isNamespaceMarker("review-doc: advisory — blocking-set PR (manual merge)", "doc"),
		));
	it("accepts a leading-bold marker", () =>
		assert.isTrue(isNamespaceMarker(`**review-doc: FAIL @ ${HEAD}** — changes-requested`, "doc")));
	it("rejects another gate's marker (the emission bug)", () =>
		assert.isFalse(isNamespaceMarker(`review-code: PASS @ ${HEAD} — merge-ready`, "doc")));
	it("rejects a non-marker first line", () =>
		assert.isFalse(isNamespaceMarker("just a normal comment", "doc")));
});

describe("isUnboundPolarityMarker — the post SHA-required-for-polarity guard (#2646)", () => {
	it("flags a PASS with an empty `@ -` SHA (the observed `@-` case)", () =>
		assert.isTrue(isUnboundPolarityMarker("review-doc: PASS @ -", "doc")));
	it("flags a PASS with no `@ <sha>` at all", () =>
		assert.isTrue(isUnboundPolarityMarker("review-doc: PASS — merge-ready", "doc")));
	it("flags a FAIL with a too-short (<7 hex) SHA", () =>
		assert.isTrue(isUnboundPolarityMarker("review-doc: FAIL @ abc12", "doc")));
	it("allows a well-formed PASS @ <sha>", () =>
		assert.isFalse(isUnboundPolarityMarker(`review-doc: PASS @ ${HEAD} — merge-ready`, "doc")));
	it("allows an advisory (SHA-less, no polarity) line", () =>
		assert.isFalse(isUnboundPolarityMarker("review-doc: advisory — see thread", "doc")));
	it("allows another gate's marker (not this namespace's concern)", () =>
		assert.isFalse(isUnboundPolarityMarker("review-code: PASS — merge-ready", "doc")));
});

describe("malformedEmittedSha — the post full-40-hex emission guard (#2683)", () => {
	const SHA40 = "a".repeat(40);
	const MKTEMP = "/var/folders/8f/r3k3t6817cgbsxsxvxk83q4c0000gn/T/tmp.TgExIt22qT";

	it("flags a PASS marker whose `@ <sha>` is a full mktemp path (the observed leak shape)", () =>
		assert.isNotNull(malformedEmittedSha(`review-code: PASS @${MKTEMP} — merge-ready`, "code")));
	it("flags a 40-hex SHA glued to a trailing path (the ≥7-hex-prefix gap isUnbound misses)", () =>
		assert.isNotNull(
			malformedEmittedSha(`review-code: PASS @ ${SHA40}${MKTEMP} — merge-ready`, "code"),
		));
	it("flags a short (7–39 hex) first-line SHA — emission requires the FULL 40", () =>
		assert.isNotNull(
			malformedEmittedSha("review-code: PASS @ abc1234def5678 — merge-ready", "code"),
		));
	it("flags a §CP advisory whose `Reviewed-head:` anchor is an mktemp path (the PR #2680 site)", () =>
		assert.isNotNull(
			malformedEmittedSha(
				`review-code: advisory — see thread\n\nReviewed-head: @${MKTEMP}`,
				"code",
			),
		));
	it("flags a §CP advisory whose `Reviewed-head:` anchor is a short SHA", () =>
		assert.isNotNull(
			malformedEmittedSha(`review-code: advisory\n\nReviewed-head: @ abc1234def5678`, "code"),
		));

	it("passes a clean full-40-hex PASS marker", () =>
		assert.isNull(malformedEmittedSha(`review-code: PASS @ ${SHA40} — merge-ready`, "code")));
	it("passes a §CP advisory with a clean full-40-hex `Reviewed-head:` anchor", () =>
		assert.isNull(
			malformedEmittedSha(
				`review-code: advisory — blocking-set PR (manual merge)\n\nReviewed-head: @ ${SHA40}`,
				"code",
			),
		));
	it("passes a bare advisory with no SHA field at all", () =>
		assert.isNull(malformedEmittedSha("review-code: advisory — see thread", "code")));
});

describe("emissionDefect — the one gate `post` and `validate` share (#2683/#2772/#2796)", () => {
	const SHA40 = "a".repeat(40);
	const MKTEMP = "/var/folders/8f/r3k3t6817cgbsxsxvxk83q4c0000gn/T/tmp.TgExIt22qT";

	it("null (postable) for a clean full-40-hex PASS marker", () =>
		assert.isNull(emissionDefect(`review-doc: PASS @ ${SHA40} — merge-ready`, "doc")));
	it("null (postable) for a §CP advisory with an inline body + clean Reviewed-head", () =>
		assert.isNull(
			emissionDefect(
				`review-doc: advisory — blocking-set PR (manual merge)\n\nverified apps/web and packages/pipeline-cli\n\nReviewed-head: @ ${SHA40}`,
				"doc",
			),
		));
	it("defect for a cross-namespace body (review-code on the doc gate)", () =>
		assert.isNotNull(emissionDefect(`review-code: PASS @ ${SHA40} — merge-ready`, "doc")));
	it("defect for an unbound `@-` polarity marker (the #2646 case)", () =>
		assert.isNotNull(emissionDefect("review-doc: PASS @ -", "doc")));
	it("defect for a path-glued SHA field (the #2683 case)", () =>
		assert.isNotNull(
			emissionDefect("review-doc: PASS @ /var/folders/T/tmp.X — merge-ready", "doc"),
		));

	// The #2816/#2818 recurrence: a /var/folders mktemp path in the @<sha> field, refused loudly.
	it("defect for a /var/folders mktemp path in the @<sha> field (#2772 variant, #2816/#2818)", () =>
		assert.isNotNull(emissionDefect(`review-code: PASS @${MKTEMP} — merge-ready`, "code")));
	it("defect for a /var/folders mktemp path in the Reviewed-head anchor", () =>
		assert.isNotNull(
			emissionDefect(`review-code: advisory — see thread\n\nReviewed-head: @${MKTEMP}`, "code"),
		));
	// The #2789 case: the whole body is a bare @filepath — its first line is not a marker.
	it("defect for a whole-body bare @filepath scratchpad ref (#2789/#2796)", () =>
		assert.isNotNull(
			emissionDefect("@/private/tmp/claude-501/session/scratchpad/verdict.md", "code"),
		));
	// The hole checks 1–3 miss: a valid line-1 marker but a temp path in the PROSE tail.
	it("defect for a temp path in verdict PROSE with an otherwise-valid marker (the prose hole)", () =>
		assert.isNotNull(
			emissionDefect(
				`review-code: PASS @ ${SHA40}\n\nreviewed the diff staged at ${MKTEMP}`,
				"code",
			),
		));
	it("defect for a /Users home path in verdict prose", () =>
		assert.isNotNull(
			emissionDefect(`review-code: PASS @ ${SHA40}\n\nsee /Users/foo/scratch/notes`, "code"),
		));
});

// The #3801 post-time head cross-check core: which head SHAs a body binds, and whether they match a
// given live head. This is the pure decision `Github.post` drives at the boundary — the cross-PR
// contamination guard tested end-to-end over the mock spawner in github-service.unit.test.ts.
describe("boundHeadShas — the head SHAs a verdict body binds itself to", () => {
	const HEAD = "c6192dee".repeat(5); // 40 hex
	const OTHER = "80f6b847".repeat(5); // 40 hex

	it("collects the first-line PASS/FAIL marker's @ <sha>", () =>
		assert.deepStrictEqual(boundHeadShas(`review-code: PASS @ ${HEAD} — merge-ready`, "code"), [
			HEAD,
		]));

	it("collects the §CP advisory's Reviewed-head: anchor SHA", () =>
		assert.deepStrictEqual(
			boundHeadShas(`review-code: advisory — see thread\n\nReviewed-head: @ ${HEAD}`, "code"),
			[HEAD],
		));

	it("collects BOTH the marker @ <sha> and the Reviewed-head: anchor", () =>
		assert.deepStrictEqual(
			boundHeadShas(
				`review-code: PASS @ ${HEAD} — merge-ready\n\nReviewed-head: @ ${OTHER}`,
				"code",
			),
			[HEAD, OTHER],
		));

	it("a SHA-less advisory binds nothing (empty array)", () =>
		assert.deepStrictEqual(boundHeadShas("review-code: advisory — see thread", "code"), []));

	it("another gate's marker is not read as this gate's binding", () =>
		assert.deepStrictEqual(boundHeadShas(`review-doc: PASS @ ${HEAD}`, "code"), []));
});

describe("bindsSameHead — the head dimension of the upsert key (#4007)", () => {
	const HEAD = "c6192dee".repeat(5); // the head being re-gated, 40 hex
	const PRIOR = "80f6b847".repeat(5); // the head the prior verdict attested, 40 hex
	const at = (sha: string) => `review-code: PASS @ ${sha} — merge-ready`;

	it("two bodies bound to the SAME head → same fact (upsert)", () =>
		assert.isTrue(bindsSameHead(at(HEAD), at(HEAD), "code")));

	it("a PRIOR head's verdict vs a new head's → different fact (append, never edit in place)", () =>
		assert.isFalse(bindsSameHead(at(PRIOR), at(HEAD), "code")));

	it("an abbreviated binding still matches the full head it names (ADR 0058 rule 3)", () =>
		assert.isTrue(bindsSameHead(at(HEAD.slice(0, 12)), at(HEAD), "code")));

	it("polarity is not part of the key — a FAIL→PASS correction at one head still upserts", () =>
		assert.isTrue(
			bindsSameHead(`review-code: FAIL @ ${HEAD} — not merge-ready`, at(HEAD), "code"),
		));

	it("two §CP advisories anchored to the same head → same fact (upsert)", () =>
		assert.isTrue(
			bindsSameHead(
				`review-code: advisory — round 1\n\nReviewed-head: @ ${HEAD}`,
				`review-code: advisory — round 2\n\nReviewed-head: @ ${HEAD}`,
				"code",
			),
		));

	it("a §CP advisory re-anchored to a NEW head → different fact (append)", () =>
		assert.isFalse(
			bindsSameHead(
				`review-code: advisory — round 1\n\nReviewed-head: @ ${PRIOR}`,
				`review-code: advisory — round 2\n\nReviewed-head: @ ${HEAD}`,
				"code",
			),
		));

	it("two bind-nothing advisories are the same fact by construction (upsert preserved)", () =>
		assert.isTrue(
			bindsSameHead("review-code: advisory — see thread", "review-code: advisory — again", "code"),
		));

	it("a bound body never matches an unbound one (neither can overwrite the other)", () => {
		assert.isFalse(bindsSameHead("review-code: advisory — see thread", at(HEAD), "code"));
		assert.isFalse(bindsSameHead(at(HEAD), "review-code: advisory — see thread", "code"));
	});
});

describe("headBindingDefect — refuse a body bound to a head other than the target PR's (#3801)", () => {
	const HEAD = "c6192dee".repeat(5); // the target PR's live head, 40 hex
	const FOREIGN = "80f6b847".repeat(5); // a DIFFERENT PR's head — a clobbered cross-PR body

	it("a marker bound to a FOREIGN head → defect (the cross-PR contamination case)", () =>
		assert.isNotNull(
			headBindingDefect(`review-code: PASS @ ${FOREIGN} — merge-ready`, "code", HEAD),
		));

	it("a Reviewed-head: anchor bound to a FOREIGN head → defect", () =>
		assert.isNotNull(
			headBindingDefect(
				`review-code: advisory — see thread\n\nReviewed-head: @ ${FOREIGN}`,
				"code",
				HEAD,
			),
		));

	it("a marker bound to the target PR's own head → null (postable)", () =>
		assert.isNull(headBindingDefect(`review-code: PASS @ ${HEAD} — merge-ready`, "code", HEAD)));

	it("a SHA-less advisory binds nothing → null (nothing to cross-check)", () =>
		assert.isNull(headBindingDefect("review-code: advisory — see thread", "code", HEAD)));

	it("an abbreviated bound SHA that prefixes the live head → null (ADR 0058 rule 3)", () =>
		assert.isNull(
			headBindingDefect(`review-code: PASS @ ${HEAD.slice(0, 12)} — merge-ready`, "code", HEAD),
		));

	it("fail-closed: an empty/unresolvable head refuses any body that binds a SHA", () =>
		assert.isNotNull(headBindingDefect(`review-code: PASS @ ${HEAD} — merge-ready`, "code", "")));

	it("fail-closed exemption: an empty head still passes a bind-nothing advisory", () =>
		assert.isNull(headBindingDefect("review-code: advisory — see thread", "code", "")));
});

describe("the run-identity trailer — the upsert key's run dimension (#4016)", () => {
	const RUN = "ddf8f459-b75f-4de2-9051-8df10da5b55c";
	const OTHER_RUN = "11111111-2222-3333-4444-555555555555";
	const SHA40 = "a".repeat(40);
	const BODY = `review-doc: PASS @ ${SHA40} — merge-ready`;

	it("runIdOf reads back the id withRunId stamped", () =>
		assert.strictEqual(runIdOf(withRunId(BODY, RUN)), RUN));

	it("runIdOf is null for a pre-#4016 / hand-rolled marker (never provably ours)", () =>
		assert.isNull(runIdOf(BODY)));

	it("runIdOf does not read a trailer merely quoted mid-line", () =>
		assert.isNull(runIdOf(`${BODY}\n\nprose <!-- verdict-run: ${RUN} --> prose`)));

	it("withRunId replaces a foreign run's trailer rather than stacking a second", () => {
		const restamped = withRunId(withRunId(BODY, OTHER_RUN), RUN);
		assert.strictEqual(runIdOf(restamped), RUN);
		assert.strictEqual(restamped.split("verdict-run:").length - 1, 1);
	});

	it("a stamped body still passes every emission guard (marker stays on line one)", () =>
		assert.isNull(emissionDefect(withRunId(BODY, RUN), "doc")));

	it("normalizeRunId keeps a session-id-shaped token, lowercased", () =>
		assert.strictEqual(normalizeRunId(` ${RUN.toUpperCase()} `), RUN));

	it("normalizeRunId is null for absent/malformed ids (⇒ append, never a blind overwrite)", () => {
		assert.isNull(normalizeRunId(undefined));
		assert.isNull(normalizeRunId(""));
		assert.isNull(normalizeRunId("short"));
		assert.isNull(normalizeRunId("has whitespace inside"));
		assert.isNull(normalizeRunId("-->injected"));
	});
});

describe("verdictState — the ONE projection `read --expect` and `gate` both satisfy on (#4049)", () => {
	// `read` used to test `_tag === "current" && polarity === expect` while `gate` tested its own
	// `state` field. Two predicates over one resolution is what let the verbs disagree; these rows
	// pin that every outcome shape maps to exactly one state, and that `isReviewed` IS that map.
	const cases: ReadonlyArray<{
		readonly name: string;
		readonly outcome: VerdictOutcome;
		readonly state: VerdictState;
	}> = [
		{name: "nothing resolved", outcome: {_tag: "none"}, state: "absent"},
		{
			name: "a pre-0058 SHA-less marker",
			outcome: {_tag: "sha-less", commentId: 1, polarity: "PASS"},
			state: "unverified",
		},
		{
			name: "a marker bound to a dead head",
			outcome: {_tag: "stale", commentId: 1, polarity: "PASS", sha: OLD},
			state: "unverified",
		},
		{
			name: "a §CP advisory at the live head recording a [FAIL] criterion",
			outcome: {_tag: "advisory-not-all-pass", commentId: 1, sha: HEAD},
			state: "unverified",
		},
		{
			name: "a current-head PASS",
			outcome: {_tag: "current", commentId: 1, polarity: "PASS", sha: HEAD},
			state: "pass",
		},
		{
			name: "a current-head FAIL",
			outcome: {_tag: "current", commentId: 1, polarity: "FAIL", sha: HEAD},
			state: "fail",
		},
	];

	for (const {name, outcome, state} of cases) {
		it(`${name} ⇒ ${state}, and isReviewed agrees in both polarities`, () => {
			assert.strictEqual(verdictState(outcome), state);
			assert.strictEqual(isReviewed(outcome, "PASS"), state === "pass");
			assert.strictEqual(isReviewed(outcome, "FAIL"), state === "fail");
		});
	}

	it("a not-all-PASS advisory is NOT a FAIL — its remedy is a re-review, not a repair round", () => {
		const outcome: VerdictOutcome = {_tag: "advisory-not-all-pass", commentId: 3, sha: HEAD};
		assert.isFalse(isReviewed(outcome, "FAIL"));
		assert.include(outcomeReason(outcome, "PASS"), "not all-PASS");
	});
});
