/**
 * The leading-jump decision, arm by arm.
 *
 * The two that carry the guard are the escape itself — a jump into another checkout followed by a
 * program that reaches git in a child process, which is the shape the harness's textual check
 * misses — and the jump that stays home, because a guard that refused ordinary work inside the
 * worktree would be turned off within the day.
 */
import {describe, expect, it} from "vitest";
import {decideJump, parseLeadingJump} from "./leading-jump.ts";

const TREE = "/work/repo/.claude/worktrees/agent-a";
const SHARED = "/work/repo";
const HOME = "/Users/operator";

const decide = (command: string, cwd: string = TREE) =>
	decideJump({command, cwd, workingTree: TREE, home: HOME});

describe("the jump this guard exists for", () => {
	it("refuses the shape that moved the shared checkout: a jump out, then a program reaching git", () => {
		const out = decide(`cd ${SHARED} && node packages/fabrika-cli/src/bin.ts build branch 5795`);

		expect(out._tag).toBe("Deny");
		expect(out._tag === "Deny" && out.reason).toContain(SHARED);
		expect(out._tag === "Deny" && out.reason).toContain(TREE);
	});

	it("refuses it whatever follows the jump — nothing downstream of the `&&` is read", () => {
		expect(decide(`cd ${SHARED} && ls`)._tag).toBe("Deny");
		expect(decide(`cd ${SHARED}; fabrika build branch 1`)._tag).toBe("Deny");
		expect(decide(`cd ${SHARED}`)._tag).toBe("Deny");
	});

	it("refuses `pushd` on the same footing — the ruling names the act, not one spelling of it", () => {
		expect(decide(`pushd ${SHARED} && node bin.ts`)._tag).toBe("Deny");
	});
});

describe("the work that must keep running", () => {
	it("allows a command with no leading jump at all", () => {
		expect(decide("node packages/fabrika-cli/src/bin.ts build push")).toEqual({
			_tag: "Allow",
			because: "the command opens with no directory jump",
		});
	});

	it("allows a relative jump that stays inside the worktree", () => {
		expect(decide("cd packages/fabrika-cli && pnpm vitest run")._tag).toBe("Allow");
	});

	it("allows an absolute jump into the worktree, and a single-quoted one", () => {
		expect(decide(`cd ${TREE}/site && pnpm build`)._tag).toBe("Allow");
		expect(decide(`cd '${TREE}/site'`)._tag).toBe("Allow");
		expect(decide(`cd "${TREE}"`)._tag).toBe("Allow");
	});

	it("allows the jump written elsewhere in the line — only a LEADING one is judged", () => {
		expect(decide(`echo "cd ${SHARED}" >> notes.md`)._tag).toBe("Allow");
		expect(decide(`pnpm test && cd ${SHARED}`)._tag).toBe("Allow");
	});

	it("does not read a command that merely starts with the letters as a jump", () => {
		expect(decide("cdk deploy")._tag).toBe("Allow");
		expect(decide("cdate")._tag).toBe("Allow");
	});
});

describe("the targets that cannot be resolved before the shell runs them", () => {
	it("refuses an expansion, a glob, and the previous directory", () => {
		for (const command of ['cd "$SHARED" && git status', "cd /work/*/repo", "cd -"]) {
			const out = decide(command);
			expect(out._tag).toBe("Deny");
			expect(out._tag === "Deny" && out.reason).toContain("cannot be decided before it runs");
		}
	});

	it("refuses a jump carrying more than one operand rather than picking one", () => {
		expect(decide(`cd -P ${TREE}`)._tag).toBe("Deny");
	});

	it("reads a single-quoted target as literal — a single quote cannot expand", () => {
		expect(parseLeadingJump("cd '$SHARED'")).toEqual({
			_tag: "Literal",
			keyword: "cd",
			target: "$SHARED",
		});
	});
});

describe("the home directory", () => {
	it("reads a bare `cd` as the jump home it is, and refuses it", () => {
		expect(parseLeadingJump("cd")).toEqual({_tag: "Literal", keyword: "cd", target: "~"});
		expect(decide("cd")._tag).toBe("Deny");
		expect(decide("cd ~/code/elsewhere")._tag).toBe("Deny");
	});

	it("refuses a `~` target when HOME is unset rather than resolving it to nothing", () => {
		const out = decideJump({command: "cd ~", cwd: TREE, workingTree: TREE, home: undefined});

		expect(out._tag).toBe("Deny");
		expect(out._tag === "Deny" && out.reason).toContain("HOME is unset");
	});
});

describe("containment", () => {
	it("does not read a sibling tree sharing the prefix as inside", () => {
		expect(decide(`cd ${TREE}-2`)._tag).toBe("Deny");
	});

	it("allows the worktree root itself", () => {
		expect(decide(`cd ${TREE}`)._tag).toBe("Allow");
	});

	it("resolves a relative target against the cwd, not against the worktree root", () => {
		expect(decide("cd ../agent-b", `${TREE}/packages`)._tag).toBe("Allow");
		expect(decide("cd ../agent-b", TREE)._tag).toBe("Deny");
	});
});
