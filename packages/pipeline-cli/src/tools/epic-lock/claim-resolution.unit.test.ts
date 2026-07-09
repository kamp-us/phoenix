import {assert, describe, it} from "@effect/vitest";
import {
	CLAIM_RE,
	type ClaimComment,
	type ClaimOutcome,
	ownClaimCommentIds,
	parseClaimSession,
	resolveClaim,
	resolveWinner,
} from "./claim-resolution.ts";

const SID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SID_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const claim = (session: string): string => `claim: ${session} · 2026-07-08T00:00:00Z`;

const comment = (over: Partial<ClaimComment> & {readonly id: number}): ClaimComment => ({
	author: "usirin",
	createdAt: "2026-07-08T00:00:00Z",
	body: claim(SID_A),
	...over,
});

describe("parseClaimSession / CLAIM_RE — the canonical §7 marker", () => {
	const cases: ReadonlyArray<{readonly body: string; readonly expected: string | null}> = [
		{body: claim(SID_A), expected: SID_A},
		{body: `**claim: ${SID_B} · 2026-07-08T00:00:00Z`, expected: SID_B}, // leading-bold emphasis-tolerant (§7 \**)
		{body: `  claim:  ${SID_C}`, expected: SID_C}, // leading/inner whitespace
		{body: `CLAIM: ${SID_A} · now`, expected: SID_A}, // case-insensitive keyword
		{body: "just a normal comment", expected: null},
		{body: "claim: not-a-uuid", expected: null},
		{body: `prefix claim: ${SID_A}`, expected: null}, // must anchor at line start
	];
	for (const {body, expected} of cases) {
		it(`${JSON.stringify(body)} → ${expected}`, () => {
			assert.strictEqual(parseClaimSession(body), expected);
			assert.strictEqual(CLAIM_RE.test(body), expected !== null);
		});
	}
});

describe("resolveClaim — the epic-lock win/lose decision (table-driven)", () => {
	const cases: ReadonlyArray<{
		readonly name: string;
		readonly comments: ReadonlyArray<ClaimComment>;
		readonly authorized: ReadonlyArray<string>;
		readonly sessionId: string | null | undefined;
		readonly expected: ClaimOutcome;
	}> = [
		{
			name: "single acquirer wins",
			comments: [comment({id: 1, author: "usirin", body: claim(SID_A)})],
			authorized: ["usirin"],
			sessionId: SID_A,
			expected: {_tag: "won", winner: {session: SID_A, id: 1, createdAt: "2026-07-08T00:00:00Z"}},
		},
		{
			name: "co-acquire tie broken by earliest created_at — earlier wins",
			comments: [
				comment({id: 20, author: "usirin", createdAt: "2026-07-08T00:00:02Z", body: claim(SID_B)}),
				comment({id: 10, author: "usirin", createdAt: "2026-07-08T00:00:01Z", body: claim(SID_A)}),
			],
			authorized: ["usirin"],
			sessionId: SID_A,
			expected: {_tag: "won", winner: {session: SID_A, id: 10, createdAt: "2026-07-08T00:00:01Z"}},
		},
		{
			name: "co-acquire loser (our claim is not the earliest) → lost, defer to winner",
			comments: [
				comment({id: 10, author: "usirin", createdAt: "2026-07-08T00:00:01Z", body: claim(SID_A)}),
				comment({id: 20, author: "usirin", createdAt: "2026-07-08T00:00:02Z", body: claim(SID_B)}),
			],
			authorized: ["usirin"],
			sessionId: SID_B,
			expected: {_tag: "lost", winner: {session: SID_A, id: 10, createdAt: "2026-07-08T00:00:01Z"}},
		},
		{
			name: "equal created_at → tie broken by the smaller comment id",
			comments: [
				comment({id: 30, author: "usirin", createdAt: "2026-07-08T00:00:00Z", body: claim(SID_B)}),
				comment({id: 15, author: "usirin", createdAt: "2026-07-08T00:00:00Z", body: claim(SID_A)}),
			],
			authorized: ["usirin"],
			sessionId: SID_A,
			expected: {_tag: "won", winner: {session: SID_A, id: 15, createdAt: "2026-07-08T00:00:00Z"}},
		},
		{
			name: "a forged claim from a non-collaborator is ignored (dropped before the tiebreak)",
			comments: [
				// the earliest claim BUT from a non-authorized author — must not win
				comment({id: 5, author: "attacker", createdAt: "2026-07-08T00:00:00Z", body: claim(SID_C)}),
				comment({id: 9, author: "usirin", createdAt: "2026-07-08T00:00:05Z", body: claim(SID_A)}),
			],
			authorized: ["usirin"],
			sessionId: SID_A,
			expected: {_tag: "won", winner: {session: SID_A, id: 9, createdAt: "2026-07-08T00:00:05Z"}},
		},
		{
			name: "only a forged claim exists → no authorized winner (fail-closed)",
			comments: [comment({id: 5, author: "attacker", body: claim(SID_C)})],
			authorized: ["usirin"],
			sessionId: SID_A,
			expected: {_tag: "no-winner"},
		},
		{
			name: "empty authorized set → no winner (fail-closed, never a false win)",
			comments: [comment({id: 1, author: "usirin", body: claim(SID_A)})],
			authorized: [],
			sessionId: SID_A,
			expected: {_tag: "no-winner"},
		},
		{
			name: "missing session id fails closed (no-session) even with our own claim present",
			comments: [comment({id: 1, author: "usirin", body: claim(SID_A)})],
			authorized: ["usirin"],
			sessionId: undefined,
			expected: {_tag: "no-session"},
		},
		{
			name: "empty-string session id also fails closed (no-session)",
			comments: [comment({id: 1, author: "usirin", body: claim(SID_A)})],
			authorized: ["usirin"],
			sessionId: "",
			expected: {_tag: "no-session"},
		},
	];

	for (const {name, comments, authorized, sessionId, expected} of cases) {
		it(name, () => {
			assert.deepStrictEqual(
				resolveClaim({comments, authorizedAuthors: authorized, sessionId}),
				expected,
			);
		});
	}
});

describe("resolveWinner — direct earliest-authorized-claim resolution", () => {
	it("returns null on an empty comment set", () => {
		assert.strictEqual(resolveWinner([], ["usirin"]), null);
	});
	it("ignores non-claim comments from authorized authors", () => {
		const comments = [comment({id: 1, author: "usirin", body: "not a claim at all"})];
		assert.strictEqual(resolveWinner(comments, ["usirin"]), null);
	});
});

describe("ownClaimCommentIds — the release retraction set", () => {
	it("selects exactly our own claim comments across a mixed set", () => {
		const comments = [
			comment({id: 1, author: "usirin", body: claim(SID_A)}), // mine
			comment({id: 2, author: "usirin", body: claim(SID_B)}), // another session
			comment({id: 3, author: "usirin", body: "chatter"}), // not a claim
			comment({id: 4, author: "usirin", body: claim(SID_A)}), // mine (a retried acquire)
		];
		assert.deepStrictEqual(ownClaimCommentIds(comments, SID_A), [1, 4]);
	});
	it("is empty when we hold no claim", () => {
		assert.deepStrictEqual(ownClaimCommentIds([comment({id: 1, body: claim(SID_B)})], SID_A), []);
	});
});
