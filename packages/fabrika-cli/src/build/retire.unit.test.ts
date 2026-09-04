import {describe, expect, it} from "vitest";
import {LANE_TOKEN, NONCE, SIBLING_NONCE, SIBLING_TOKEN} from "./fixtures.test-support.ts";
import {type BoardState, classify, seatResidue, sessionsByNonce, subjectsFor} from "./retire.ts";

const BRANCH = `build/4312-editor-focus-loss-${NONCE}`;
const PATH = "/trees/agent-a9bd";
const BASE = "origin/main";

const subject = (branch = BRANCH, path = PATH) => {
	const [only] = subjectsFor(4312, [{path, branch}]);
	if (only === undefined) throw new Error(`${branch} is not a lane branch for #4312`);
	return only;
};

const board = (overrides: Partial<BoardState> = {}): BoardState => ({
	terminal: false,
	describe: "is open",
	adoptedSessions: [],
	sessionByNonce: {},
	...overrides,
});

const NOBODY = new Set<string>();

describe("subjectsFor", () => {
	it("keeps the worktrees holding a lane branch of the number, in either lane mode", () => {
		const held = subjectsFor(4312, [
			{path: "/a", branch: BRANCH},
			{path: "/b", branch: `build/pr-4312-${SIBLING_NONCE}`},
		]);

		expect(held.map((s) => s.path)).toEqual(["/a", "/b"]);
	});

	it("keeps no worktree on another number's lane branch, or on no lane branch at all", () => {
		const held = subjectsFor(4312, [
			{path: "/a", branch: `build/4313-other-work-${NONCE}`},
			{path: "/b", branch: "main"},
			{path: "/c", branch: "worktree-agent-a9bd"},
		]);

		expect(held).toEqual([]);
	});
});

describe("classify — the terminal-ticket license", () => {
	it("releases a worktree whose ticket is terminal", () => {
		const verdict = classify(subject(), board({terminal: true, describe: "is closed"}), NOBODY);

		expect(verdict).toMatchObject({_tag: "Release", license: "ticket-terminal"});
	});

	it("releases a terminal ticket's worktree WITHOUT reading dirtiness — dirty is not a refusal", () => {
		// The founder's ruling on #6610: an agent routinely leaves a worktree dirty after its ticket
		// merged, so dirtiness is a false negative for "work in progress". The predicate takes no
		// dirtiness input at all, which is what makes that unrepresentable rather than merely unused.
		expect(Object.keys(board())).not.toContain("dirty");
		expect(
			classify(subject(), board({terminal: true, describe: "is merged"}), NOBODY),
		).toMatchObject({_tag: "Release", license: "ticket-terminal"});
	});

	it("holds a claimed worktree whose ticket is not terminal, and says what the board reads", () => {
		const verdict = classify(subject(), board({sessionByNonce: {[NONCE]: "s-9f2e"}}), NOBODY);

		expect(verdict._tag).toBe("Hold");
		expect(verdict._tag === "Hold" && verdict.because).toMatch(/#4312 is open/);
	});
});

describe("classify — the adopted-session license", () => {
	it("releases when an authorized adopt names the session whose claim carries this branch's nonce", () => {
		const verdict = classify(
			subject(),
			board({adoptedSessions: ["s-9f2e"], sessionByNonce: {[NONCE]: "s-9f2e"}}),
			NOBODY,
		);

		expect(verdict).toMatchObject({_tag: "Release", license: "session-adopted"});
	});

	it("holds when the adopt names a different session than this branch's lane took", () => {
		const verdict = classify(
			subject(),
			board({adoptedSessions: ["s-other"], sessionByNonce: {[NONCE]: "s-9f2e"}}),
			NOBODY,
		);

		expect(verdict._tag).toBe("Hold");
		expect(verdict._tag === "Hold" && verdict.because).toMatch(/names session s-9f2e/);
	});

	it("defers to the tree when no claim marker on the board carries this branch's nonce", () => {
		const verdict = classify(
			subject(),
			board({adoptedSessions: ["s-9f2e"], sessionByNonce: {[SIBLING_NONCE]: "s-9f2e"}}),
			NOBODY,
		);

		expect(verdict).toEqual({_tag: "Unclaimed"});
	});
});

describe("classify / seatResidue — the unclaimed-lane license", () => {
	const held = board({sessionByNonce: {[NONCE]: "s-9f2e"}});

	it("holds a branch a live claim marker still carries, before the tree is read at all", () => {
		expect(classify(subject(), held, NOBODY)._tag).toBe("Hold");
	});

	it("releases an unclaimed subject whose tree is clean and whose branch is level with the base", () => {
		const verdict = seatResidue(subject(), {uncommitted: 0, commitsPastBase: 0, base: BASE});

		expect(verdict).toMatchObject({_tag: "Release", license: "lane-unclaimed"});
	});

	it("holds an unclaimed subject holding uncommitted work, naming the count that blocked it", () => {
		const verdict = seatResidue(subject(), {uncommitted: 3, commitsPastBase: 0, base: BASE});

		expect(verdict._tag).toBe("Hold");
		expect(verdict._tag === "Hold" && verdict.because).toMatch(/3 uncommitted path\(s\)/);
	});

	it("holds an unclaimed subject whose branch carries commits past the base, naming the base", () => {
		const verdict = seatResidue(subject(), {uncommitted: 0, commitsPastBase: 2, base: BASE});

		expect(verdict._tag).toBe("Hold");
		expect(verdict._tag === "Hold" && verdict.because).toMatch(/2 commit\(s\) past origin\/main/);
	});

	it("names BOTH counts when a tree carries both — there is no second read to find the other", () => {
		const verdict = seatResidue(subject(), {uncommitted: 1, commitsPastBase: 4, base: BASE});

		expect(verdict._tag === "Hold" && verdict.because).toMatch(
			/1 uncommitted path\(s\) and 4 commit\(s\) past origin\/main/,
		);
	});
});

describe("classify — the tree this run is standing in", () => {
	it("is Self even when the board would license it, so no run removes itself", () => {
		const verdict = classify(
			subject(),
			board({terminal: true, describe: "is closed"}),
			new Set([PATH]),
		);

		expect(verdict).toEqual({_tag: "Self"});
	});
});

describe("sessionsByNonce", () => {
	it("maps an authorized marker's lane nonce to the session that took it", () => {
		const map = sessionsByNonce([
			{token: LANE_TOKEN, session: "s-9f2e", authorized: true},
			{token: SIBLING_TOKEN, session: "s-9f2e", authorized: true},
		]);

		expect(map).toEqual({[NONCE]: "s-9f2e", [SIBLING_NONCE]: "s-9f2e"});
	});

	it("counts no unauthorized marker — content is not authority (ADR 0055)", () => {
		expect(sessionsByNonce([{token: LANE_TOKEN, session: "s-9f2e", authorized: false}])).toEqual(
			{},
		);
	});

	it("keeps the EARLIEST authorized marker's session on a nonce, as every other reader does", () => {
		const map = sessionsByNonce([
			{token: LANE_TOKEN, session: "s-first", authorized: true},
			{token: LANE_TOKEN, session: "s-later", authorized: true},
		]);

		expect(map).toEqual({[NONCE]: "s-first"});
	});
});
