import {assert, describe, it} from "@effect/vitest";
import type {ClaimComment, ClaimLiveness} from "../epic-lock/claim-resolution.ts";
import {type ClaimVerdict, claimIsMine} from "./claim-is-mine.ts";

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

describe("claimIsMine — the issue-scoped default-deny resolver decision", () => {
	const cases: ReadonlyArray<{
		readonly name: string;
		readonly comments: ReadonlyArray<ClaimComment>;
		readonly authorized: ReadonlyArray<string>;
		readonly sessionId: string | null | undefined;
		readonly liveness?: ReadonlyMap<number, ClaimLiveness>;
		readonly expected: ClaimVerdict;
	}> = [
		{
			name: "the earliest authorized claim is ours → mine",
			comments: [comment({id: 1, author: "usirin", body: claim(SID_A)})],
			authorized: ["usirin"],
			sessionId: SID_A,
			expected: {
				mine: true,
				reason: "won",
				winner: {session: SID_A, id: 1, createdAt: "2026-07-08T00:00:00Z"},
				superseded: [],
			},
		},
		{
			name: "a foreign earliest claim owns the issue → not-mine (lost, defer to the holder)",
			comments: [
				comment({id: 10, author: "usirin", createdAt: "2026-07-08T00:00:01Z", body: claim(SID_A)}),
				comment({id: 20, author: "usirin", createdAt: "2026-07-08T00:00:02Z", body: claim(SID_B)}),
			],
			authorized: ["usirin"],
			sessionId: SID_B,
			expected: {
				mine: false,
				reason: "lost",
				winner: {session: SID_A, id: 10, createdAt: "2026-07-08T00:00:01Z"},
				superseded: [],
			},
		},
		{
			name: "FAIL-SAFE: no authorized claim resolves (only a forged non-collaborator claim) → not-mine (default-deny)",
			comments: [comment({id: 5, author: "attacker", body: claim(SID_C)})],
			authorized: ["usirin"],
			sessionId: SID_A,
			expected: {mine: false, reason: "no-winner", winner: null, superseded: []},
		},
		{
			name: "FAIL-SAFE: empty authorized set resolves no owner → not-mine (default-deny, never a false win)",
			comments: [comment({id: 1, author: "usirin", body: claim(SID_A)})],
			authorized: [],
			sessionId: SID_A,
			expected: {mine: false, reason: "no-winner", winner: null, superseded: []},
		},
		{
			name: "FAIL-SAFE: missing session id → not-mine (default-deny) even with our own claim present",
			comments: [comment({id: 1, author: "usirin", body: claim(SID_A)})],
			authorized: ["usirin"],
			sessionId: undefined,
			expected: {mine: false, reason: "no-session", winner: null, superseded: []},
		},
		{
			name: "FAIL-SAFE: empty-string session id → not-mine (default-deny)",
			comments: [comment({id: 1, author: "usirin", body: claim(SID_A)})],
			authorized: ["usirin"],
			sessionId: "",
			expected: {mine: false, reason: "no-session", winner: null, superseded: []},
		},
		{
			name: "FAIL-SAFE: no claim comments at all → not-mine (default-deny)",
			comments: [],
			authorized: ["usirin"],
			sessionId: SID_A,
			expected: {mine: false, reason: "no-winner", winner: null, superseded: []},
		},
		{
			// The #3751 orchestrated-repair case: the dead original claimant's older marker no longer
			// shadows the re-drive's claim, so the mis-attribution guard can actually resolve MINE.
			name: "a PROVABLY DEAD earliest claimant is superseded → our later claim wins",
			comments: [
				comment({id: 10, author: "usirin", createdAt: "2026-07-20T06:42:00Z", body: claim(SID_A)}),
				comment({id: 20, author: "usirin", createdAt: "2026-07-22T05:33:00Z", body: claim(SID_B)}),
			],
			authorized: ["usirin"],
			sessionId: SID_B,
			liveness: new Map<number, ClaimLiveness>([[10, "dead"]]),
			expected: {
				mine: true,
				reason: "won",
				winner: {session: SID_B, id: 20, createdAt: "2026-07-22T05:33:00Z"},
				superseded: [{session: SID_A, id: 10, createdAt: "2026-07-20T06:42:00Z"}],
			},
		},
		{
			name: "INDETERMINATE liveness stays fail-closed: an unprobeable earliest claimant still owns → not-mine",
			comments: [
				comment({id: 10, author: "usirin", createdAt: "2026-07-20T06:42:00Z", body: claim(SID_A)}),
				comment({id: 20, author: "usirin", createdAt: "2026-07-22T05:33:00Z", body: claim(SID_B)}),
			],
			authorized: ["usirin"],
			sessionId: SID_B,
			liveness: new Map<number, ClaimLiveness>([[10, "unknown"]]),
			expected: {
				mine: false,
				reason: "lost",
				winner: {session: SID_A, id: 10, createdAt: "2026-07-20T06:42:00Z"},
				superseded: [],
			},
		},
		{
			name: "a LIVE earliest claimant is never evicted → not-mine (no reclaim of a slow-but-live agent)",
			comments: [
				comment({id: 10, author: "usirin", createdAt: "2026-07-20T06:42:00Z", body: claim(SID_A)}),
				comment({id: 20, author: "usirin", createdAt: "2026-07-22T05:33:00Z", body: claim(SID_B)}),
			],
			authorized: ["usirin"],
			sessionId: SID_B,
			liveness: new Map<number, ClaimLiveness>([[10, "live"]]),
			expected: {
				mine: false,
				reason: "lost",
				winner: {session: SID_A, id: 10, createdAt: "2026-07-20T06:42:00Z"},
				superseded: [],
			},
		},
		{
			name: "FAIL-SAFE: every authorized claim superseded → no-winner (default-deny), never a false win",
			comments: [
				comment({id: 10, author: "usirin", createdAt: "2026-07-20T06:42:00Z", body: claim(SID_A)}),
			],
			authorized: ["usirin"],
			sessionId: SID_B,
			liveness: new Map<number, ClaimLiveness>([[10, "dead"]]),
			expected: {
				mine: false,
				reason: "no-winner",
				winner: null,
				superseded: [{session: SID_A, id: 10, createdAt: "2026-07-20T06:42:00Z"}],
			},
		},
	];

	for (const {name, comments, authorized, sessionId, liveness, expected} of cases) {
		it(name, () => {
			assert.deepStrictEqual(
				claimIsMine({comments, authorizedAuthors: authorized, sessionId, liveness}),
				expected,
			);
		});
	}

	it("is default-deny for EVERY non-won outcome — the only true answer is a proven-own claim", () => {
		// Property: across the un-resolvable inputs, `mine` is never true. A caller that
		// cannot prove ownership always backs off (the #3250 fail-safe license).
		const denials: ReadonlyArray<ClaimVerdict> = [
			claimIsMine({comments: [], authorizedAuthors: ["usirin"], sessionId: SID_A}),
			claimIsMine({
				comments: [comment({id: 1, author: "attacker"})],
				authorizedAuthors: ["usirin"],
				sessionId: SID_A,
			}),
			claimIsMine({comments: [comment({id: 1})], authorizedAuthors: [], sessionId: SID_A}),
			claimIsMine({comments: [comment({id: 1})], authorizedAuthors: ["usirin"], sessionId: null}),
			// A superseded-away claim set is still default-deny for a session with no claim of its own.
			claimIsMine({
				comments: [comment({id: 1})],
				authorizedAuthors: ["usirin"],
				sessionId: SID_B,
				liveness: new Map<number, ClaimLiveness>([[1, "dead"]]),
			}),
		];
		for (const verdict of denials) assert.strictEqual(verdict.mine, false);
	});
});
