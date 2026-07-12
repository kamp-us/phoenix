import {assert, describe, it} from "@effect/vitest";
import {
	emissionDefect,
	isBoundToHead,
	isNamespaceMarker,
	isReviewed,
	isUnboundPolarityMarker,
	malformedEmittedSha,
	parseVerdict,
	resolveVerdict,
	type VerdictComment,
	type VerdictGate,
	type VerdictOutcome,
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

describe("emissionDefect — the one gate `post` and `validate` share (#2683)", () => {
	const SHA40 = "a".repeat(40);

	it("null (postable) for a clean full-40-hex PASS marker", () =>
		assert.isNull(emissionDefect(`review-doc: PASS @ ${SHA40} — merge-ready`, "doc")));
	it("defect for a cross-namespace body (review-code on the doc gate)", () =>
		assert.isNotNull(emissionDefect(`review-code: PASS @ ${SHA40} — merge-ready`, "doc")));
	it("defect for an unbound `@-` polarity marker (the #2646 case)", () =>
		assert.isNotNull(emissionDefect("review-doc: PASS @ -", "doc")));
	it("defect for a path-glued SHA field (the #2683 case)", () =>
		assert.isNotNull(
			emissionDefect("review-doc: PASS @ /var/folders/T/tmp.X — merge-ready", "doc"),
		));
});
