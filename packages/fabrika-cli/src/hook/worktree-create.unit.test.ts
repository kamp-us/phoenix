import {describe, expect, it} from "vitest";
import {loadGoldenPayload} from "../golden-fixture.ts";
import {childEnv, planWorktree, toolchainPath, worktreePathFor} from "./worktree-create.ts";

describe("planning a worktree from a WorktreeCreate payload", () => {
	it("constructs the path from the captured envelope's cwd and name", () => {
		const payload = loadGoldenPayload(
			import.meta.url,
			"__fixtures__/worktree-create.payload.golden.json",
		);
		const read = planWorktree(payload);
		expect(read).toEqual({
			_tag: "Plan",
			plan: {
				repoRoot: "/private/tmp/fabrika-worktree-capture/repo",
				name: "capture-probe",
				worktreePath: "/private/tmp/fabrika-worktree-capture/repo/.claude/worktrees/capture-probe",
			},
		});
	});

	it("lays the tree where the harness's own default path lays it", () => {
		expect(worktreePathFor("/repo", "agent-abc")).toBe("/repo/.claude/worktrees/agent-abc");
	});

	it.each([
		["an absent cwd", {name: "agent-1"}, "carries no `cwd`"],
		["a relative cwd", {cwd: "repo", name: "agent-1"}, "not an absolute path"],
		["an absent name", {cwd: "/repo"}, "carries no `name`"],
		["a blank name", {cwd: "/repo", name: "   "}, "carries no `name`"],
	])("refuses %s rather than composing a path from it", (_label, payload, reason) => {
		const read = planWorktree(payload);
		expect(read._tag).toBe("Unplannable");
		if (read._tag === "Unplannable") expect(read.reason).toContain(reason);
	});

	/**
	 * The harness rejects a returned path with dot segments — but by then the hook has already run
	 * `git worktree add` at it, so the refusal has to happen here, before the mutation.
	 */
	it.each([
		["../escape"],
		["a/b"],
		["/absolute"],
		[".hidden"],
		["-leading-dash"],
	])("refuses the traversing or odd slug %s before any git command runs", (name) => {
		expect(planWorktree({cwd: "/repo", name})._tag).toBe("Unplannable");
	});
});

describe("the PATH the git child runs under", () => {
	it("prepends the standard toolchain dirs, since a stripped PATH makes bootstrap-deps clean-SKIP", () => {
		expect(toolchainPath("/usr/bin", "/home/x").split(":")).toEqual([
			"/opt/homebrew/bin",
			"/usr/local/bin",
			"/bin",
			"/usr/bin",
			"/home/x/.local/bin",
		]);
	});

	it("keeps the inherited PATH last rather than dropping it — a toolchain elsewhere still resolves", () => {
		expect(toolchainPath("/opt/node/bin", undefined)).toBe(
			"/opt/homebrew/bin:/usr/local/bin:/bin:/usr/bin:/opt/node/bin",
		);
	});

	it("composes a usable PATH even when the hook inherited none", () => {
		expect(toolchainPath(undefined, undefined)).toBe(
			"/opt/homebrew/bin:/usr/local/bin:/bin:/usr/bin",
		);
	});
});

describe("the environment the git child runs under", () => {
	it("carries HOME, so the install reads the shared pnpm store instead of refetching the world", () => {
		expect(childEnv({PATH: "/usr/bin", HOME: "/home/x"})).toMatchObject({HOME: "/home/x"});
	});

	it("passes through nothing the list does not name — the child inherits no ambient environment", () => {
		expect(
			Object.keys(childEnv({PATH: "/usr/bin", NODE_OPTIONS: "--x", GH_TOKEN: "t"})).sort(),
		).toEqual(["PATH"]);
	});

	it("drops an empty value rather than handing the child a blank HOME", () => {
		expect(childEnv({PATH: "/usr/bin", HOME: ""})).not.toHaveProperty("HOME");
	});
});
