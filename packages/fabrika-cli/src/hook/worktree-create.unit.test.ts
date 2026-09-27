import {describe, expect, it} from "vitest";
import {loadGoldenPayload} from "../golden-fixture.ts";
import {
	childEnv,
	planAtToplevel,
	readWorktreeRequest,
	toolchainPath,
	worktreePathFor,
} from "./worktree-create.ts";

describe("reading a worktree request from a WorktreeCreate payload", () => {
	it("reads the captured envelope's cwd and name as a request, not yet a plan", () => {
		const payload = loadGoldenPayload(
			import.meta.url,
			"__fixtures__/worktree-create.payload.golden.json",
		);
		expect(readWorktreeRequest(payload)).toEqual({
			_tag: "Request",
			request: {cwd: "/private/tmp/fabrika-worktree-capture/repo", name: "capture-probe"},
		});
	});

	it("lays the tree where the harness's own default path lays it", () => {
		expect(worktreePathFor("/repo", "agent-abc")).toBe("/repo/.claude/worktrees/agent-abc");
	});

	it.each([
		["an absent cwd", {name: "agent-1"}, "the payload carries no `cwd`"],
		["a relative cwd", {cwd: "repo", name: "agent-1"}, "`cwd` is not an absolute path: repo"],
		["an absent name", {cwd: "/repo"}, "the payload carries no `name`"],
		["a blank name", {cwd: "/repo", name: "   "}, "the payload carries no `name`"],
	])("refuses %s rather than composing a path from it", (_label, payload, reason) => {
		expect(readWorktreeRequest(payload)).toEqual({_tag: "Unplannable", reason});
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
		expect(readWorktreeRequest({cwd: "/repo", name})).toEqual({
			_tag: "Unplannable",
			reason: `\`name\` is not a plain worktree slug and could escape the worktree root: ${name}`,
		});
	});
});

describe("planning a worktree at the toplevel the request's cwd resolved to", () => {
	const request = {cwd: "/repo/packages/fabrika-cli", name: "agent-1"};

	it("roots the plan at the resolved toplevel, never at the session's cwd", () => {
		expect(planAtToplevel(request, "/repo\n")).toEqual({
			_tag: "Plan",
			plan: {repoRoot: "/repo", name: "agent-1", worktreePath: "/repo/.claude/worktrees/agent-1"},
		});
	});

	it.each([
		["a failed resolution", null],
		["an empty answer", ""],
		["a relative answer", "repo"],
		["a multi-line answer", "/repo\n/other"],
	])("refuses %s and names the cwd that did not resolve", (_label, toplevel) => {
		expect(planAtToplevel(request, toplevel)).toEqual({
			_tag: "Unplannable",
			reason: "`cwd` resolves to no repository toplevel: /repo/packages/fabrika-cli",
		});
	});
});

describe("the PATH the git child runs under", () => {
	it("prepends the standard toolchain dirs, since a stripped PATH makes the install clean-SKIP", () => {
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
		).toEqual(["GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT", "PATH"]);
	});

	it("drops an empty value rather than handing the child a blank HOME", () => {
		expect(childEnv({PATH: "/usr/bin", HOME: ""})).not.toHaveProperty("HOME");
	});

	/**
	 * An SSH-only `origin` leaves a fetch with no agent socket no credential path at all —
	 * and the hook is the only way any worktree gets created once it is declared.
	 */
	it("forwards the ssh-agent channel, so the fetch against an SSH-only origin can authenticate", () => {
		expect(
			childEnv({PATH: "/usr/bin", SSH_AUTH_SOCK: "/tmp/agent.7", SSH_AGENT_PID: "812"}),
		).toMatchObject({SSH_AUTH_SOCK: "/tmp/agent.7", SSH_AGENT_PID: "812"});
	});

	it("refuses to prompt: a credential miss fails at once instead of hanging out the child timeout", () => {
		expect(childEnv({PATH: "/usr/bin"})).toMatchObject({
			GIT_TERMINAL_PROMPT: "0",
			GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
		});
	});

	it("keeps an inherited GIT_SSH_COMMAND and adds BatchMode to it rather than replacing it", () => {
		expect(
			childEnv({PATH: "/usr/bin", GIT_SSH_COMMAND: "ssh -i /keys/deploy"}).GIT_SSH_COMMAND,
		).toBe("ssh -i /keys/deploy -o BatchMode=yes");
	});

	it("adds no second BatchMode when the inherited command already sets one, in any case", () => {
		expect(
			childEnv({PATH: "/usr/bin", GIT_SSH_COMMAND: "ssh -o batchmode=YES"}).GIT_SSH_COMMAND,
		).toBe("ssh -o batchmode=YES");
	});

	/** git prefers `GIT_SSH_COMMAND`, so synthesising one would silently outrank the operator's wrapper. */
	it("leaves a lone GIT_SSH wrapper as the transport instead of overriding it", () => {
		const env = childEnv({PATH: "/usr/bin", GIT_SSH: "/opt/bin/ssh-wrapper"});
		expect(env.GIT_SSH).toBe("/opt/bin/ssh-wrapper");
		expect(env).not.toHaveProperty("GIT_SSH_COMMAND");
	});
});
