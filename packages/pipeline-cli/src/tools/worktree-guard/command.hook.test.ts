import {execFile, execFileSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
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

	it("DENIES a bare HEAD-moving git op that would detach the shared primary (#1571)", async () => {
		const {stdout} = await run(
			"pre-bash",
			{tool_name: "Bash", tool_input: {command: "git checkout 1a2b3c4"}},
			{WORKTREE_ROOT: WT},
		);
		const out = JSON.parse(stdout.trim());
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
		assert.match(out.hookSpecificOutput.permissionDecisionReason, /git -C "\$WT"/);
	}, 30_000);

	it("does NOT deny the orchestrator's bare `git checkout main` (no $WORKTREE_ROOT)", async () => {
		const {stdout} = await run(
			"pre-bash",
			{tool_name: "Bash", tool_input: {command: "git checkout main"}},
			{WORKTREE_ROOT: ""},
		);
		const out = JSON.parse(stdout.trim());
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "allow");
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

	// The #2798 owner signal lives in the payload: `transcript_path` points at the stopping agent's
	// transcript, whose sibling `.meta.json` records the worktree that agent OWNS. Build that sidecar
	// so a reap invocation carries a real owner (or nested-descendant) stop payload.
	const ownerStopPayload = (owningWorktree: string, slug: string) => {
		const subDir = join(mainRepo, "subagents");
		mkdirSync(subDir, {recursive: true});
		const transcript = join(subDir, `${slug}.jsonl`);
		writeFileSync(transcript, "");
		writeFileSync(
			join(subDir, `${slug}.meta.json`),
			JSON.stringify({worktreePath: owningWorktree}),
		);
		return {hook_event_name: "SubagentStop", transcript_path: transcript};
	};

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

	it("REAPS a clean worktree under an OWNER stop payload (it is removed)", async () => {
		assert.isTrue(existsSync(wtRoot));
		const {stderr} = await run("reap", ownerStopPayload(wtRoot, "agent-owner"), {
			WORKTREE_ROOT: wtRoot,
		});
		assert.include(stderr, "reaped clean worktree");
		assert.isFalse(existsSync(wtRoot));
	}, 30_000);

	it("KEEPS a live worktree on a NESTED-DESCENDANT stop (inherited $WORKTREE_ROOT, owns another tree)", async () => {
		const liveWt = join(mainRepo, ".claude", "worktrees", "wf_live");
		git(mainRepo, "worktree", "add", "-q", "--detach", liveWt, "HEAD");
		// The nested child owns a DIFFERENT worktree; it only inherited WORKTREE_ROOT=liveWt.
		const {stderr} = await run(
			"reap",
			ownerStopPayload("/some/other/.claude/worktrees/wf_child", "agent-child"),
			{WORKTREE_ROOT: liveWt},
		);
		assert.match(stderr, /does not own|KEEP/);
		assert.isTrue(existsSync(liveWt), "a live parent's worktree must survive a nested-child stop");
	}, 30_000);

	it("REFUSES (keeps) a dirty worktree — never --force (under an owner stop)", async () => {
		const dirtyWt = join(mainRepo, ".claude", "worktrees", "wf_dirty");
		git(mainRepo, "worktree", "add", "-q", "--detach", dirtyWt, "HEAD");
		writeFileSync(join(dirtyWt, "uncommitted.txt"), "unpushed work");
		const {stderr} = await run("reap", ownerStopPayload(dirtyWt, "agent-dirty"), {
			WORKTREE_ROOT: dirtyWt,
		});
		assert.include(stderr, "KEPT");
		assert.isTrue(existsSync(dirtyWt), "dirty worktree must be kept");
		assert.isTrue(existsSync(join(dirtyWt, "uncommitted.txt")), "unpushed file must survive");
	}, 30_000);
});
