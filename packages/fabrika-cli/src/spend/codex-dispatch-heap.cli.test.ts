import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {readUsageLedger} from "./usage-ledger.ts";
import {rollUpUsage} from "./usage-rollup.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

// Far below the history's size: collection fits only if conversation bodies are never retained.
const HEAP_MB = 64;
const FILES = 24;
const BODY_LINES = 24;
const BODY = "x".repeat(256 * 1024);
const usage = {
	input_tokens: 100,
	cached_input_tokens: 20,
	output_tokens: 10,
	reasoning_output_tokens: 3,
	total_tokens: 110,
};
const meta = (id: string, parent: string | null, cwd: string) => ({
	type: "session_meta",
	payload: {
		id,
		session_id: "root",
		parent_thread_id: parent,
		cli_version: "0.154.0",
		model_provider: "openai",
		cwd,
	},
});
const body = {
	type: "response_item",
	payload: {type: "message", role: "assistant", content: [{type: "output_text", text: BODY}]},
};
const response = (thread: string, id: string) => ({
	type: "token_usage_record",
	payload: {
		thread_id: thread,
		session_id: "root",
		turn_id: "turn-1",
		root_turn_id: "turn-1",
		response_id: id,
		usage,
		turn_token_usage: usage,
		thread_token_usage: usage,
	},
});
const transcript = (head: object, thread: string | null) => {
	const rows: object[] = [head, {type: "turn_context", payload: {turn_id: "turn-1", model: "m"}}];
	for (let line = 0; line < BODY_LINES; line++) {
		rows.push(body);
		if (thread !== null && line % (BODY_LINES / 2) === 0)
			rows.push(response(thread, `${thread}-${line}`));
	}
	return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
};
const digest = (dir: string) =>
	readdirSync(dir)
		.sort()
		.map((name) =>
			createHash("sha256")
				.update(readFileSync(join(dir, name)))
				.digest("hex"),
		);

it("collects a history far larger than its heap and records every counted response", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-dispatch-heap-"));
	dirs.push(dir);
	const sessions = join(dir, "sessions");
	mkdirSync(sessions);
	const worktree = join(dir, "worktree");
	const children = FILES / 2 - 1;
	writeFileSync(join(sessions, "root.jsonl"), transcript(meta("root", null, worktree), "root"));
	for (let i = 0; i < children; i++)
		writeFileSync(
			join(sessions, `child-${i}.jsonl`),
			transcript(meta(`child-${i}`, "root", worktree), `child-${i}`),
		);
	for (let i = 0; i < FILES / 2; i++)
		writeFileSync(
			join(sessions, `unrelated-${i}.jsonl`),
			transcript(meta(`unrelated-${i}`, null, join(dir, "elsewhere")), `unrelated-${i}`),
		);
	const before = digest(sessions);
	const ledger = join(dir, "ledger.jsonl");
	const options = {
		sessions,
		ledger,
		worktree,
		state: join(dir, "state"),
		work: {repo: "o/r", issue: 9701, run: "lane:9701:build"},
	};
	const collector = new URL("./codex-dispatch-collector.ts", import.meta.url).href;
	execFileSync(
		process.execPath,
		[
			`--max-old-space-size=${HEAP_MB}`,
			"--input-type=module",
			"-e",
			[
				`import {NodeServices} from "@effect/platform-node";`,
				`import {Effect} from "effect";`,
				`import {collectCodexDispatch} from ${JSON.stringify(collector)};`,
				`await Effect.runPromise(collectCodexDispatch(${JSON.stringify(options)}).pipe(Effect.provide(NodeServices.layer)));`,
			].join("\n"),
		],
		{cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: "pipe"},
	);
	const rollup = rollUpUsage(readUsageLedger(readFileSync(ledger, "utf8")), {issue: 9701});
	const counted = (1 + children) * 2;
	expect(rollup.responses).toBe(counted);
	expect(rollup.counters.find((row) => row.field === "input_tokens")?.tokens).toBe(
		counted * usage.input_tokens,
	);
	expect(rollup.counters.find((row) => row.field === "total_tokens")?.tokens).toBe(
		counted * usage.total_tokens,
	);
	expect(digest(sessions)).toEqual(before);
});
