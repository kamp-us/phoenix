import {describe, expect, it} from "vitest";
import {
	type GrantFacts,
	type Grantors,
	judgeGrants,
	type OwnSet,
	prOwnershipOf,
} from "./pr-ownership.ts";

const PR = 4321;
const GRANT = `takeover-granted: #${PR} · 2026-09-26T07:16:03Z\n\nTake it over. — 2026-09-26\n`;

const running: OwnSet = {
	_tag: "RunningAccount",
	login: "agent",
	why: "no `ownAccounts` is declared",
};
const declared: OwnSet = {
	_tag: "Declared",
	entries: ["@agent-bot"],
	holds: (login) => login.toLowerCase() === "agent-bot",
};
const grantors: Grantors = {_tag: "Set", holds: (login) => login === "founder" || login === "ada"};

const facts = (overrides: Partial<GrantFacts> = {}): GrantFacts => ({
	pr: PR,
	author: "ada",
	grantors,
	writes: () => true,
	...overrides,
});

describe("prOwnershipOf", () => {
	it("reads the running account as ours when no set is declared", () => {
		expect(prOwnershipOf("agent", running, [])._tag).toBe("Own");
		expect(prOwnershipOf("Agent", running, [])._tag).toBe("Own");
	});

	it("reads any other author as foreign when no set is declared", () => {
		expect(prOwnershipOf("ada", running, [])._tag).toBe("Foreign");
	});

	it("reads a declared account as ours, and the running account as nothing special", () => {
		expect(prOwnershipOf("agent-bot", declared, [])._tag).toBe("Own");
		expect(prOwnershipOf("agent", declared, [])._tag).toBe("Foreign");
	});

	it("never reads an author it could not name as ours", () => {
		expect(prOwnershipOf("", {...running, login: ""}, [])._tag).toBe("Foreign");
	});

	it("hands a foreign PR over on an honoured grant", () => {
		const rows = judgeGrants([{id: 7, author: "founder", body: GRANT}], facts());
		const read = prOwnershipOf("ada", running, rows);
		expect(read._tag).toBe("Granted");
	});
});

describe("judgeGrants", () => {
	it("honours a grant from a trusted, writing account that is not the PR's author", () => {
		expect(judgeGrants([{id: 7, author: "founder", body: GRANT}], facts())).toEqual([
			{commentId: 7, by: "founder", honoured: true},
		]);
	});

	it("voids a grant written by the PR's own author, even one in the control-plane set", () => {
		const [row] = judgeGrants([{id: 7, author: "ada", body: GRANT}], facts());
		expect(row?.honoured).toBe(false);
		expect(row?.reason).toContain("this PR's author");
	});

	it("voids a grant from an account outside the control-plane set", () => {
		const [row] = judgeGrants([{id: 7, author: "mallory", body: GRANT}], facts());
		expect(row?.honoured).toBe(false);
		expect(row?.reason).toContain("not in the control-plane set the repo's CODEOWNERS names");
	});

	it("voids every grant when nobody may grant", () => {
		const [row] = judgeGrants(
			[{id: 7, author: "founder", body: GRANT}],
			facts({grantors: {_tag: "Unusable", reason: "`capClearAuthors` is empty"}}),
		);
		expect(row?.reason).toBe("`capClearAuthors` is empty");
	});

	it("voids a grant from a configured account below write", () => {
		const [row] = judgeGrants(
			[{id: 7, author: "founder", body: GRANT}],
			facts({writes: () => false}),
		);
		expect(row?.reason).toContain("no write permission");
	});

	it("voids a grant naming another PR, and a malformed one", () => {
		const rows = judgeGrants(
			[
				{id: 7, author: "founder", body: "takeover-granted: #1 · 2026-09-26T07:16:03Z\n"},
				{id: 8, author: "founder", body: "takeover-granted: #4321 · today\n"},
			],
			facts(),
		);
		expect(rows.map((row) => row.honoured)).toEqual([false, false]);
		expect(rows[0]?.reason).toContain("grants #1, not #4321");
		expect(rows[1]?.reason).toContain("malformed");
	});

	it("reads nothing but comments that reach for the marker", () => {
		expect(judgeGrants([{id: 7, author: "founder", body: "LGTM"}], facts())).toEqual([]);
	});
});
