import {execFile} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {decideForEnvelope} from "./bin.ts";

describe("decideForEnvelope — envelope glue (fail-open)", () => {
	it("allows a non-Edit/Write tool (e.g. Bash)", () => {
		const raw = JSON.stringify({tool_name: "Bash", tool_input: {command: "ls"}});
		assert.isTrue(decideForEnvelope(raw).allow);
	});

	it("allows (fail-open) on malformed envelope JSON", () => {
		assert.isTrue(decideForEnvelope("{not json").allow);
	});

	it("allows when tool_input has no file_path", () => {
		const raw = JSON.stringify({tool_name: "Edit", tool_input: {}});
		assert.isTrue(decideForEnvelope(raw).allow);
	});
});

describe("decideForEnvelope — read-set attribution boundary (#781/#802 fail-open)", () => {
	let projectDir: string;
	let readDir: string;
	let savedProjectDir: string | undefined;
	const file = (root: string, name: string, content: string): string => {
		const p = join(root, name);
		writeFileSync(p, content, "utf8");
		return p;
	};
	const transcript = (root: string, name: string, lines: ReadonlyArray<unknown>): string => {
		const p = join(root, name);
		writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
		return p;
	};
	const readLine = (filePath: string, iso: string) => ({
		timestamp: iso,
		message: {content: [{type: "tool_use", name: "Read", input: {file_path: filePath}}]},
	});

	beforeAll(() => {
		// A real, isolated on-disk `$CLAUDE_PROJECT_DIR` for the boundary tests; `readDir`
		// stands in for a sibling fork repo OUTSIDE it. Save/restore the env so the CLI
		// end-to-end block (which spawns child processes inheriting env) is unaffected.
		projectDir = mkdtempSync(join(tmpdir(), "read-guard-project-"));
		readDir = mkdtempSync(join(tmpdir(), "read-guard-fork-"));
		savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
		process.env.CLAUDE_PROJECT_DIR = projectDir;
	});
	afterAll(() => {
		if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
		else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(readDir, {recursive: true, force: true});
	});

	it("ALLOWS (fail-open) an Edit OUTSIDE $CLAUDE_PROJECT_DIR — sibling-fork edit, #802", () => {
		// A never-read target in a sibling repo, judged against a non-empty phoenix read-set:
		// without the boundary check this is a sound-looking 'never-read' DENY. It must ALLOW.
		const forkTarget = file(readDir, "fork-src.ts", "x");
		const inProject = file(projectDir, "seen.ts", "y");
		const tr = transcript(projectDir, "fork.jsonl", [
			readLine(inProject, "2026-06-19T10:00:00.000Z"),
		]);
		const raw = JSON.stringify({
			tool_name: "Edit",
			tool_input: {file_path: forkTarget},
			transcript_path: tr,
		});
		assert.isTrue(decideForEnvelope(raw).allow);
	});

	it("ALLOWS (fail-open) an Edit of a worktree-subagent target under .claude/worktrees/ — #781", () => {
		// The subagent's own Reads live in a SEPARATE subagent transcript; the handed
		// transcript carries the PARENT session's reads (non-empty) but NOT this target's,
		// so without the worktree-attribution carve-out it reads as never-read → wrong DENY.
		const worktreeRoot = join(projectDir, ".claude", "worktrees", "agent-abc123");
		mkdirSync(worktreeRoot, {recursive: true});
		const worktreeTarget = file(worktreeRoot, "edit-me.ts", "x");
		const parentRead = file(projectDir, "parent-read.ts", "y");
		const tr = transcript(projectDir, "worktree.jsonl", [
			readLine(parentRead, "2026-06-19T10:00:00.000Z"),
		]);
		const raw = JSON.stringify({
			tool_name: "Edit",
			tool_input: {file_path: worktreeTarget},
			transcript_path: tr,
		});
		assert.isTrue(decideForEnvelope(raw).allow);
	});

	it("still DENIES a genuine never-read Edit of an in-project file with a reliable read-set — #755 preserved", () => {
		// In-project (not under .claude/worktrees/), reliable non-empty read-set that does
		// NOT contain the target → a SOUND never-read deny. The fail-open carve-outs must
		// not blanket-disable this.
		const target = file(projectDir, "never.ts", "x");
		const other = file(projectDir, "other.ts", "y");
		const tr = transcript(projectDir, "never.jsonl", [readLine(other, "2026-06-19T10:00:00.000Z")]);
		const raw = JSON.stringify({
			tool_name: "Edit",
			tool_input: {file_path: target},
			transcript_path: tr,
		});
		const decision = decideForEnvelope(raw);
		assert.isFalse(decision.allow);
		assert.include(decision.reason ?? "", target);
	});
});

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
}

const runHook = (envelope: unknown): Promise<RunResult> =>
	new Promise((resolve) => {
		const child = execFile("node", [BIN], (error, stdout) => {
			const code =
				error && typeof (error as {code?: unknown}).code === "number"
					? (error as {code: number}).code
					: 0;
			resolve({code, stdout});
		});
		child.stdin?.end(JSON.stringify(envelope));
	});

describe("bin PreToolUse hook — end to end over the real CLI", () => {
	let dir: string;
	const file = (name: string, content: string): string => {
		const p = join(dir, name);
		writeFileSync(p, content, "utf8");
		return p;
	};
	const transcript = (name: string, lines: ReadonlyArray<unknown>): string => {
		const p = join(dir, name);
		writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
		return p;
	};
	const readLine = (filePath: string, iso: string) => ({
		timestamp: iso,
		message: {content: [{type: "tool_use", name: "Read", input: {file_path: filePath}}]},
	});

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "read-guard-bin-"));
	});
	afterAll(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("DENIES an Edit of a never-read file with a Read-first instruction", async () => {
		const target = file("never.ts", "x");
		// A reliable (NON-empty) read-set of an UNRELATED file: the target itself is never
		// read, so the guard can soundly deny. An EMPTY read-set is the worktree/child-session
		// can't-reconstruct case (fail-open test below), NOT a sound "never-read".
		const other = file("other.ts", "y");
		const tr = transcript("never.jsonl", [readLine(other, "2026-06-19T10:00:00.000Z")]);
		const {code, stdout} = await runHook({
			tool_name: "Edit",
			tool_input: {file_path: target},
			transcript_path: tr,
		});
		assert.strictEqual(code, 0); // the hook itself succeeds; the decision is in the JSON
		const out = JSON.parse(stdout);
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
		assert.include(out.systemMessage, target);
		assert.include(out.systemMessage, "Read");
	}, 30_000);

	it("FAILS OPEN on an empty/unreconstructable read-set — defers to the harness native read-before-edit check (#740/#776 worktree/child-session transcript-shape bug)", async () => {
		const target = file("worktree-edit.ts", "x");
		const tr = transcript("empty.jsonl", []); // zero reads reconstructable = unreliable, not a sound "never-read"
		const {stdout} = await runHook({
			tool_name: "Edit",
			tool_input: {file_path: target},
			transcript_path: tr,
		});
		const out = JSON.parse(stdout);
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "allow");
	}, 30_000);

	it("DENIES an Edit of a file modified since it was read", async () => {
		const target = file("stale.ts", "x");
		// recorded read at an instant strictly BEFORE the file's current mtime
		const readAt = "2000-01-01T00:00:00.000Z";
		const tr = transcript("stale.jsonl", [readLine(target, readAt)]);
		const {stdout} = await runHook({
			tool_name: "Edit",
			tool_input: {file_path: target},
			transcript_path: tr,
		});
		const out = JSON.parse(stdout);
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
		assert.include(out.systemMessage, "changed on disk");
	}, 30_000);

	it("ALLOWS an Edit of a current-read file (proceeds, no extra Read)", async () => {
		const target = file("fresh.ts", "x");
		// set the file's mtime into the past, then record a read AFTER that → fresh
		const past = new Date("2020-01-01T00:00:00.000Z");
		utimesSync(target, past, past);
		const tr = transcript("fresh.jsonl", [readLine(target, "2026-06-19T10:00:00.000Z")]);
		const {stdout} = await runHook({
			tool_name: "Edit",
			tool_input: {file_path: target},
			transcript_path: tr,
		});
		const out = JSON.parse(stdout);
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "allow");
	}, 30_000);

	it("ALLOWS a Write creating a brand-new file (never read, not on disk)", async () => {
		const target = join(dir, "brand-new.ts");
		const tr = transcript("new.jsonl", []);
		const {stdout} = await runHook({
			tool_name: "Write",
			tool_input: {file_path: target},
			transcript_path: tr,
		});
		const out = JSON.parse(stdout);
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "allow");
	}, 30_000);
});
