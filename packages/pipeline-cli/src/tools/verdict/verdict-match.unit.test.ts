import {assert, describe, it} from "@effect/vitest";
import {
	boundHeadShas,
	emissionDefect,
	headBindingDefect,
	isBoundToHead,
	isNamespaceMarker,
	isReviewed,
	isUnboundPolarityMarker,
	malformedEmittedSha,
	normalizeRunId,
	parseVerdict,
	resolveVerdict,
	runIdOf,
	type VerdictComment,
	type VerdictGate,
	type VerdictOutcome,
	withRunId,
} from "./verdict-match.ts";

const HEAD = "abc1234def5678";
const OLD = "0000000aaaa1111";

const marker = (over: Partial<VerdictComment> & {readonly id: number}): VerdictComment => ({
	author: "usirin",
	createdAt: "2026-07-11T00:00:00Z",
	body: `review-doc: PASS @ ${HEAD} — merge-ready`,
	...over,
});

const CODE_FAIL_AT_HEAD = `review-code: FAIL @ ${HEAD} — changes-requested`;

/** The canonical §CP advisory shape: SHA-less first line, head bound in the body (ADR 0111/0151). */
const allPassAdvisory = (reviewedHead: string): string =>
	[
		"review-code: advisory — blocking-set PR (manual merge)",
		"",
		`Reviewed-head: @ ${reviewedHead}`,
		"",
		"- [PASS] the linkage seam is armed",
		"- [PASS] the diff matches the acceptance criteria",
	].join("\n");

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
		/** §CP-ness: omitted ⇒ a plain auto-merge PR, where the advisory is not a candidate at all. */
		readonly controlPlane?: boolean;
		readonly expected: VerdictOutcome;
		readonly reviewedPass: boolean;
		/** Does the outcome satisfy an `--expect FAIL` read (the write-code repair seam)? */
		readonly reviewedFail?: boolean;
	}> = [
		{
			name: "matching @sha PASS → current PASS (reviewed)",
			comments: [marker({id: 1})],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "current", form: "marker", commentId: 1, polarity: "PASS", sha: HEAD},
			reviewedPass: true,
		},
		{
			name: "SHA-less advisory PASS does NOT satisfy the SHA-bound check",
			comments: [marker({id: 1, body: "review-doc: PASS — merge-ready"})],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "sha-less", form: "marker", commentId: 1, polarity: "PASS"},
			reviewedPass: false,
		},
		{
			name: "a verdict bound to a stale sha does NOT pass",
			comments: [marker({id: 1, body: `review-doc: PASS @ ${OLD} — merge-ready`})],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "stale", form: "marker", commentId: 1, polarity: "PASS", sha: OLD},
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
			expected: {_tag: "current", form: "marker", commentId: 2, polarity: "FAIL", sha: HEAD},
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
			expected: {_tag: "current", form: "marker", commentId: 2, polarity: "FAIL", sha: HEAD},
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
			expected: {_tag: "current", form: "marker", commentId: 20, polarity: "PASS", sha: HEAD},
			reviewedPass: true,
		},
		// The run-scoped upsert (#4016) means two reviewer RUNS can now leave two verdict comments
		// at ONE head, where the author-keyed upsert used to collapse them to one. Resolution is
		// unchanged by that: latest-wins on `(createdAt, id)` still decides (ADR 0058) — the newer
		// verdict supersedes the older, exactly as a re-review at the same head always did.
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
			expected: {_tag: "current", form: "marker", commentId: 2, polarity: "PASS", sha: HEAD},
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
			expected: {_tag: "current", form: "marker", commentId: 2, polarity: "FAIL", sha: HEAD},
			reviewedPass: false,
		},
		{
			name: "empty authorized set → none (fail-closed, never a false win)",
			comments: [marker({id: 1})],
			authorized: [],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "none", form: "none"},
			reviewedPass: false,
		},
		{
			name: "no marker in the namespace → none",
			comments: [marker({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`})],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "none", form: "none"},
			reviewedPass: false,
		},
		{
			name: "an advisory-only namespace → none (advisory is not a machine PASS)",
			comments: [marker({id: 1, body: "review-doc: advisory — blocking-set PR (manual merge)"})],
			authorized: ["usirin"],
			gate: "doc",
			head: HEAD,
			expected: {_tag: "none", form: "none"},
			reviewedPass: false,
		},
		// The #4049 body-only-repair sequence, the PR #3988 marker set: two FAILs and an all-PASS
		// advisory, ALL bound to the one head the repair deliberately did not move. Recency across
		// both forms is what retires the superseded FAILs — staleness-invalidation structurally
		// cannot, since nothing moved.
		{
			name: "§CP body-only repair: the newer all-PASS advisory supersedes the same-head FAILs (#4049)",
			comments: [
				marker({id: 1, createdAt: "2026-07-24T06:51:00Z", body: CODE_FAIL_AT_HEAD}),
				marker({id: 2, createdAt: "2026-07-24T19:16:00Z", body: CODE_FAIL_AT_HEAD}),
				marker({id: 3, createdAt: "2026-07-24T19:22:00Z", body: allPassAdvisory(HEAD)}),
			],
			authorized: ["usirin"],
			gate: "code",
			head: HEAD,
			controlPlane: true,
			expected: {_tag: "current", form: "advisory", commentId: 3, polarity: "PASS", sha: HEAD},
			reviewedPass: true,
			reviewedFail: false,
		},
		{
			name: "the same marker set on a NON-§CP PR: the advisory is no candidate, so the FAIL still stands",
			comments: [
				marker({id: 1, createdAt: "2026-07-24T06:51:00Z", body: CODE_FAIL_AT_HEAD}),
				marker({id: 2, createdAt: "2026-07-24T19:16:00Z", body: CODE_FAIL_AT_HEAD}),
				marker({id: 3, createdAt: "2026-07-24T19:22:00Z", body: allPassAdvisory(HEAD)}),
			],
			authorized: ["usirin"],
			gate: "code",
			head: HEAD,
			expected: {_tag: "current", form: "marker", commentId: 2, polarity: "FAIL", sha: HEAD},
			reviewedPass: false,
			reviewedFail: true,
		},
		{
			name: "§CP: a FAIL posted AFTER the advisory is the in-force verdict (recency, not form, decides)",
			comments: [
				marker({id: 1, createdAt: "2026-07-24T19:00:00Z", body: allPassAdvisory(HEAD)}),
				marker({id: 2, createdAt: "2026-07-24T19:16:00Z", body: CODE_FAIL_AT_HEAD}),
			],
			authorized: ["usirin"],
			gate: "code",
			head: HEAD,
			controlPlane: true,
			expected: {_tag: "current", form: "marker", commentId: 2, polarity: "FAIL", sha: HEAD},
			reviewedPass: false,
			reviewedFail: true,
		},
		{
			name: "§CP: a current-head advisory carrying a [FAIL] checkbox is neither a pass nor a marker FAIL",
			comments: [
				marker({id: 1, createdAt: "2026-07-24T06:51:00Z", body: CODE_FAIL_AT_HEAD}),
				marker({
					id: 2,
					createdAt: "2026-07-24T19:22:00Z",
					body: `${allPassAdvisory(HEAD)}\n- [FAIL] the linkage token still auto-closes`,
				}),
			],
			authorized: ["usirin"],
			gate: "code",
			head: HEAD,
			controlPlane: true,
			expected: {_tag: "advisory-not-all-pass", form: "advisory", commentId: 2, sha: HEAD},
			reviewedPass: false,
			reviewedFail: false,
		},
		{
			name: "§CP: an advisory with no Reviewed-head anchor binds nothing (ADR 0151) — unverified",
			comments: [
				marker({
					id: 1,
					createdAt: "2026-07-24T19:22:00Z",
					body: "review-code: advisory — blocking-set PR (manual merge)\n\n- [PASS] every check",
				}),
			],
			authorized: ["usirin"],
			gate: "code",
			head: HEAD,
			controlPlane: true,
			expected: {_tag: "sha-less", form: "advisory", commentId: 1, polarity: null},
			reviewedPass: false,
			reviewedFail: false,
		},
		{
			name: "§CP: an advisory whose Reviewed-head is a superseded head is stale, never a pass",
			comments: [marker({id: 1, createdAt: "2026-07-24T19:22:00Z", body: allPassAdvisory(OLD)})],
			authorized: ["usirin"],
			gate: "code",
			head: HEAD,
			controlPlane: true,
			expected: {_tag: "stale", form: "advisory", commentId: 1, polarity: null, sha: OLD},
			reviewedPass: false,
			reviewedFail: false,
		},
	];
	for (const {
		name,
		comments,
		authorized,
		gate,
		head,
		controlPlane,
		expected,
		reviewedPass,
		reviewedFail,
	} of cases) {
		it(name, () => {
			const outcome = resolveVerdict({
				comments,
				authorizedAuthors: authorized,
				gate,
				headSha: head,
				controlPlane: controlPlane ?? false,
			});
			assert.deepStrictEqual(outcome, expected);
			assert.strictEqual(isReviewed(outcome, "PASS"), reviewedPass);
			if (reviewedFail !== undefined) {
				assert.strictEqual(isReviewed(outcome, "FAIL"), reviewedFail);
			}
		});
	}

	it("cross-namespace isolation: the same PASS resolves per gate", () => {
		const comments = [
			marker({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`}),
			marker({id: 2, body: `review-skill: FAIL @ ${HEAD} — changes-requested`}),
		];
		assert.deepStrictEqual(
			resolveVerdict({
				comments,
				authorizedAuthors: ["usirin"],
				gate: "code",
				headSha: HEAD,
				controlPlane: false,
			}),
			{_tag: "current", form: "marker", commentId: 1, polarity: "PASS", sha: HEAD},
		);
		assert.deepStrictEqual(
			resolveVerdict({
				comments,
				authorizedAuthors: ["usirin"],
				gate: "skill",
				headSha: HEAD,
				controlPlane: false,
			}),
			{_tag: "current", form: "marker", commentId: 2, polarity: "FAIL", sha: HEAD},
		);
		assert.deepStrictEqual(
			resolveVerdict({
				comments,
				authorizedAuthors: ["usirin"],
				gate: "doc",
				headSha: HEAD,
				controlPlane: false,
			}),
			{_tag: "none", form: "none"},
		);
	});
});

describe("isReviewed — read-verb decision over expected polarity", () => {
	it("current FAIL satisfies an expect-FAIL read (write-code repair seam)", () => {
		const outcome: VerdictOutcome = {
			_tag: "current",
			form: "marker",
			commentId: 1,
			polarity: "FAIL",
			sha: HEAD,
		};
		assert.isTrue(isReviewed(outcome, "FAIL"));
		assert.isFalse(isReviewed(outcome, "PASS"));
	});
	it("a stale verdict never satisfies either polarity", () => {
		const outcome: VerdictOutcome = {
			_tag: "stale",
			form: "marker",
			commentId: 1,
			polarity: "PASS",
			sha: OLD,
		};
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
