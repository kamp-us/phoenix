import {execFile, execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

// `pipeline-cli worktree-guard <subcommand>` is the hook surface.
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const run = (
	subcommand: string,
	stdinJson: unknown,
	env: Record<string, string>,
): Promise<RunResult> =>
	new Promise((resolve) => {
		const child = execFile(
			"node",
			[BIN, "worktree-guard", subcommand],
			{env: {...process.env, ...env}},
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as {code?: unknown}).code === "number"
						? (error as {code: number}).code
						: 0;
				resolve({code, stdout, stderr});
			},
		);
		child.stdin?.end(JSON.stringify(stdinJson));
	});

describe("worktree-guard pre-file — PreToolUse envelope", () => {
	const WT = "/Users/dev/code/phoenix/.claude/worktrees/wf_xyz";
	const MAIN = "/Users/dev/code/phoenix";

	it("emits allow + updatedInput rewriting a relative path to $WORKTREE_ROOT", async () => {
		const {stdout, code} = await run(
			"pre-file",
			{tool_name: "Edit", cwd: MAIN, tool_input: {file_path: "packages/foo/x.ts"}},
			{WORKTREE_ROOT: WT},
		);
		assert.strictEqual(code, 0);
		const out = JSON.parse(stdout.trim());
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "allow");
		assert.strictEqual(out.hookSpecificOutput.updatedInput.file_path, `${WT}/packages/foo/x.ts`);
	}, 30_000);

	it("emits a plain allow with no $WORKTREE_ROOT (non-worktree session no-op)", async () => {
		const {stdout} = await run(
			"pre-file",
			{tool_name: "Edit", cwd: MAIN, tool_input: {file_path: "packages/foo/x.ts"}},
			{WORKTREE_ROOT: ""},
		);
		const out = JSON.parse(stdout.trim());
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "allow");
		assert.isUndefined(out.hookSpecificOutput.updatedInput);
	}, 30_000);
});

describe("worktree-guard pre-bash — PreToolUse envelope", () => {
	const WT = "/Users/dev/code/phoenix/.claude/worktrees/wf_xyz";

	it("pins a Bash command lacking a cd", async () => {
		const {stdout} = await run(
			"pre-bash",
			{tool_name: "Bash", tool_input: {command: "git status"}},
			{WORKTREE_ROOT: WT},
		);
		const out = JSON.parse(stdout.trim());
		assert.strictEqual(out.hookSpecificOutput.updatedInput.command, `cd "${WT}" && git status`);
	}, 30_000);
});

describe("worktree-guard pre-enter — hard-block nested worktree", () => {
	it("denies EnterWorktree when $WORKTREE_ROOT is set", async () => {
		const {stdout} = await run(
			"pre-enter",
			{tool_name: "EnterWorktree"},
			{
				WORKTREE_ROOT: "/Users/dev/code/phoenix/.claude/worktrees/wf_xyz",
			},
		);
		const out = JSON.parse(stdout.trim());
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
	}, 30_000);

	it("allows EnterWorktree at top level", async () => {
		const {stdout} = await run("pre-enter", {tool_name: "EnterWorktree"}, {WORKTREE_ROOT: ""});
		const out = JSON.parse(stdout.trim());
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "allow");
	}, 30_000);
});

describe("worktree-guard reap — SubagentStop reaper against a REAL git worktree", () => {
	let mainRepo: string;
	let wtRoot: string;

	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"});

	beforeAll(() => {
		// A real main checkout with a worktree under the managed .claude/worktrees layout.
		mainRepo = mkdtempSync(join(tmpdir(), "wtg-main-"));
		git(mainRepo, "init", "-q", "-b", "main");
		git(mainRepo, "config", "user.email", "t@t.t");
		git(mainRepo, "config", "user.name", "t");
		writeFileSync(join(mainRepo, "README.md"), "x");
		git(mainRepo, "add", ".");
		git(mainRepo, "commit", "-q", "-m", "init");
		wtRoot = join(mainRepo, ".claude", "worktrees", "wf_reap");
		// Detached HEAD: `main` is already checked out in mainRepo, so add the worktree at
		// the commit (the same constraint real agent worktrees branch around).
		git(mainRepo, "worktree", "add", "-q", "--detach", wtRoot, "HEAD");
	});

	afterAll(() => {
		rmSync(mainRepo, {recursive: true, force: true});
	});

	it("REAPS a clean worktree (it is removed)", async () => {
		assert.isTrue(existsSync(wtRoot));
		const {stderr} = await run("reap", {hook_event_name: "SubagentStop"}, {WORKTREE_ROOT: wtRoot});
		assert.include(stderr, "reaped clean worktree");
		assert.isFalse(existsSync(wtRoot));
	}, 30_000);

	it("REFUSES (keeps) a dirty worktree — never --force", async () => {
		const dirtyWt = join(mainRepo, ".claude", "worktrees", "wf_dirty");
		git(mainRepo, "worktree", "add", "-q", "--detach", dirtyWt, "HEAD");
		writeFileSync(join(dirtyWt, "uncommitted.txt"), "unpushed work");
		const {stderr} = await run("reap", {hook_event_name: "SubagentStop"}, {WORKTREE_ROOT: dirtyWt});
		assert.include(stderr, "KEPT");
		assert.isTrue(existsSync(dirtyWt), "dirty worktree must be kept");
		assert.isTrue(existsSync(join(dirtyWt, "uncommitted.txt")), "unpushed file must survive");
	}, 30_000);
});
