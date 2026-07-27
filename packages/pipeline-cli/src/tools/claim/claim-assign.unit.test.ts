import {assert, describe, it} from "@effect/vitest";
import {type AssignPlan, assignPlan} from "./claim-assign.ts";
import type {ClaimVerdict} from "./claim-is-mine.ts";

const SID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const mine: ClaimVerdict = {
	mine: true,
	reason: "won",
	winner: {session: SID_A, id: 1, createdAt: "2026-07-26T00:00:00Z"},
	superseded: [],
};

const notMine = (reason: ClaimVerdict["reason"], winner: string | null): ClaimVerdict => ({
	mine: false,
	reason,
	winner: winner === null ? null : {session: winner, id: 1, createdAt: "2026-07-26T00:00:00Z"},
	superseded: [],
});

describe("assignPlan — the layer-one decision (gh-issue-intake-formats.md §7, #4298)", () => {
	const cases: ReadonlyArray<{
		readonly name: string;
		readonly verdict: ClaimVerdict;
		readonly login: string;
		readonly assignees: ReadonlyArray<string>;
		readonly expected: AssignPlan;
	}> = [
		{
			name: "our claim + an empty gate → write layer one",
			verdict: mine,
			login: "usirin",
			assignees: [],
			expected: {_tag: "assign", login: "usirin"},
		},
		{
			name: "our claim + a gate already carrying us → idempotent no-op",
			verdict: mine,
			login: "usirin",
			assignees: ["usirin"],
			expected: {_tag: "already-set", login: "usirin"},
		},
		{
			name: "our claim + a gate carrying only someone else → add ours, never displace theirs",
			verdict: mine,
			login: "usirin",
			assignees: ["cansirin"],
			expected: {_tag: "assign", login: "usirin"},
		},
		{
			name: "login case differs → still already-set (GitHub logins are case-insensitive)",
			verdict: mine,
			login: "usirin",
			assignees: ["USirin"],
			expected: {_tag: "already-set", login: "usirin"},
		},
		{
			name: "DEFAULT-DENY: a foreign owner → refuse, whatever the gate says",
			verdict: notMine("lost", SID_B),
			login: "usirin",
			assignees: [],
			expected: {_tag: "refuse", reason: "lost", owner: SID_B},
		},
		{
			name: "DEFAULT-DENY: no authorized claim at all → refuse (never infer ownership from an empty lane)",
			verdict: notMine("no-winner", null),
			login: "usirin",
			assignees: [],
			expected: {_tag: "refuse", reason: "no-winner", owner: null},
		},
		{
			name: "DEFAULT-DENY: no session id to resolve under → refuse",
			verdict: notMine("no-session", null),
			login: "usirin",
			assignees: [],
			expected: {_tag: "refuse", reason: "no-session", owner: null},
		},
		{
			name: "our claim but no resolvable login → refuse rather than write an unnamed gate",
			verdict: mine,
			login: "  ",
			assignees: [],
			expected: {_tag: "refuse", reason: "no-login", owner: SID_A},
		},
	];

	for (const c of cases) {
		it(c.name, () => {
			assert.deepStrictEqual(
				assignPlan({verdict: c.verdict, login: c.login, assignees: c.assignees}),
				c.expected,
			);
		});
	}

	it("the gate is never read as ownership: a not-mine verdict refuses even when it already carries us", () => {
		assert.deepStrictEqual(
			assignPlan({verdict: notMine("lost", SID_B), login: "usirin", assignees: ["usirin"]}),
			{_tag: "refuse", reason: "lost", owner: SID_B},
		);
	});
});
