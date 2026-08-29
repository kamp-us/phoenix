import {describe, expect, it} from "vitest";
import {traceRange} from "../lane/prove.ts";
import {NONCE, SIBLING_NONCE} from "./fixtures.test-support.ts";
import {childLaneBranches} from "./lane.ts";
import {RETIRED_PREFIX, retiredBranchName, supersede} from "./retire-branch.ts";

const LIVE = `build/6296-editor-focus-loss-${NONCE}`;
const STALE = `build/6296-editor-focus-loss-${SIBLING_NONCE}`;

describe("retiredBranchName", () => {
	it("moves a lane branch out of build/ and keeps every other character", () => {
		expect(retiredBranchName(LIVE)).toBe(`${RETIRED_PREFIX}6296-editor-focus-loss-${NONCE}`);
	});

	it("names no target for a branch that is not in build/ — there is nothing to retire", () => {
		expect(retiredBranchName("main")).toBeNull();
		expect(retiredBranchName(`${RETIRED_PREFIX}6296-editor-focus-loss-${NONCE}`)).toBeNull();
	});
});

describe("supersede", () => {
	it("keeps the branch an authorized marker's nonce names and supersedes the rest", () => {
		expect(supersede(6296, [STALE, LIVE], {[NONCE]: "s-9f2e"})).toEqual({
			_tag: "Settled",
			survivor: LIVE,
			superseded: [STALE],
		});
	});

	it("supersedes nothing when no marker carries any candidate's nonce", () => {
		const seated = supersede(6296, [STALE, LIVE], {});

		expect(seated._tag).toBe("Unattested");
		expect(seated._tag === "Unattested" && seated.why).toContain("no authorized claim marker");
	});

	it("supersedes nothing when two candidates are each attested — two live claims, no order", () => {
		const seated = supersede(6296, [STALE, LIVE], {[NONCE]: "s-9f2e", [SIBLING_NONCE]: "s-other"});

		expect(seated._tag).toBe("Unattested");
		expect(seated._tag === "Unattested" && seated.why).toContain("two live claims");
	});
});

describe("a retired branch leaves the candidate set — the deadlock ADR 0324 clears", () => {
	const fact = (branch: string) => ({
		branch,
		base: "664eb9d",
		tip: branch === LIVE ? "03135b9" : "8f1c2ad",
		messages: ["feat(lane): do the thing (#6296)"],
		contains: [],
	});

	it("is Many while both branches sit in build/, and One once the superseded one is renamed", () => {
		const before = childLaneBranches(6296, [STALE, LIVE, "main"]);
		expect(traceRange(6296, "epic/6200", before.map(fact))).toMatchObject({_tag: "Many"});

		const retired = retiredBranchName(STALE);
		if (retired === null) throw new Error(`${STALE} has no retired name`);
		const after = childLaneBranches(6296, [retired, LIVE, "main"]);

		expect(after).toEqual([LIVE]);
		expect(traceRange(6296, "epic/6200", after.map(fact))).toMatchObject({
			_tag: "One",
			branch: LIVE,
		});
	});
});
