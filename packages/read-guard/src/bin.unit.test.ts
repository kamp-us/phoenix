import {execFile} from "node:child_process";
import {mkdtempSync, rmSync, utimesSync, writeFileSync} from "node:fs";
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
		const tr = transcript("never.jsonl", []); // empty read-set
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
