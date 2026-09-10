import {execFileSync, spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, expect, it} from "vitest";
import type {rollUpUsage} from "./usage-rollup.ts";

const cli = fileURLToPath(new URL("../bin.ts", import.meta.url));
const codexHook = new URL("./codex-hook-verb.ts", import.meta.url).href;
const nodeServices = new URL(
	"../../node_modules/@effect/platform-node/dist/index.js",
	import.meta.url,
).href;
const effect = new URL("../../node_modules/effect/dist/index.js", import.meta.url).href;
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
const write = (path: string, rows: unknown[]) =>
	writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));

it("records both hosts across interruption, restart, nested work and retries without recounting", () => {
	const cwd = mkdtempSync(join(tmpdir(), "usage-journey-"));
	dirs.push(cwd);
	execFileSync("git", ["init", "--quiet"], {cwd});
	const ledger = join(cwd, ".fabrika/spend-ledger.jsonl");
	const sessions = join(cwd, "sessions");
	mkdirSync(sessions);
	const state = join(cwd, "codex-state");
	const runId = "codex:root:turn";
	const run = (args: string[], input?: unknown) => {
		const result = spawnSync(process.execPath, [cli, ...args], {
			cwd,
			encoding: "utf8",
			input: input === undefined ? undefined : JSON.stringify(input),
			env: {
				...process.env,
				FABRIKA_SKIP_INFER: "1",
				FABRIKA_SESSION_ID: runId,
				CLAUDE_PIPELINE_REPO: "fixture/repo",
			},
		});
		expect(result.status, result.stderr).toBe(0);
		return result.stdout;
	};
	const codex = (event: string, extra = {}) => {
		const input = {
			hook_event_name: event,
			session_id: "root",
			turn_id: "turn",
			transcript_path: join(sessions, "root.jsonl"),
			cwd,
			...extra,
		};
		const options = {input: JSON.stringify(input), sessions, state, ledger, repo: "fixture/repo"};
		const program = `import {Effect} from ${JSON.stringify(effect)}; import {NodeServices} from ${JSON.stringify(nodeServices)}; import {runCodexHook} from ${JSON.stringify(codexHook)}; const result = await Effect.runPromise(runCodexHook(${JSON.stringify(options)}).pipe(Effect.provide(NodeServices.layer))); console.log(result.stdout);`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
			cwd,
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		return result.stdout;
	};
	const usage = {
		input_tokens: 10,
		cached_input_tokens: 2,
		output_tokens: 5,
		reasoning_output_tokens: 1,
		total_tokens: 15,
	};
	const native = (thread: string, parent: string | null, model: string) => [
		{
			type: "session_meta",
			payload: {
				id: thread,
				session_id: "root",
				parent_thread_id: parent,
				cli_version: "0.154.0",
				model_provider: "openai",
			},
		},
		{type: "turn_context", payload: {turn_id: thread, model}},
		{
			type: "event_msg",
			payload: {
				type: "token_usage_record",
				thread_id: thread,
				session_id: "root",
				turn_id: thread,
				root_turn_id: "turn",
				response_id: `response-${thread}`,
				usage,
				turn_token_usage: usage,
				thread_token_usage: usage,
			},
		},
	];
	const root = native("root", null, "codex-first");
	write(join(sessions, "root.jsonl"), [...root, root[2]]);
	codex("PreToolUse", {
		tool_input: {command: "node packages/fabrika-cli/src/bin.ts build issue 8952"},
		agent_id: "late",
	});

	const transcript = join(cwd, "claude.jsonl");
	const claudeUsage = {
		input_tokens: 2,
		output_tokens: 7,
		cache_read_input_tokens: 20,
		cache_creation_input_tokens: 10,
		cache_creation: {ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4},
	};
	const response = (id: string, child?: string, model = "claude-first", tool?: string) => ({
		type: "assistant",
		sessionId: "claude",
		version: "2.1.217",
		agentId: child,
		gitBranch: "build/8952-usage-rollup-12345678",
		message: {
			id,
			role: "assistant",
			model,
			usage: claudeUsage,
			content: tool ? [{type: "tool_use", id: tool, name: "Agent"}] : [],
		},
	});
	const claudeRoot = response("claude-root", undefined, "claude-first", "spawn-a");
	write(transcript, [claudeRoot, claudeRoot]);
	const hook = (event: string, extra = {}) =>
		run(["hook", "claude-spend"], {
			session_id: "claude",
			transcript_path: transcript,
			cwd,
			hook_event_name: event,
			...extra,
		});
	hook("SubagentStart", {agent_id: "a"});
	hook("StopFailure");
	const early = JSON.parse(
		run(["spend", "rollup", "--ledger", ledger, "--issue", "8952", "--json"]),
	).usage as ReturnType<typeof rollUpUsage>;
	expect(early.responses).toBe(2);
	expect(early.coverage.groups.flatMap((group) => group.missing)).toEqual(
		expect.arrayContaining(["late", "claude/agent/a"]),
	);

	write(join(sessions, "child.jsonl"), [...native("child", "root", "codex-first"), ...root]);
	write(join(sessions, "late.jsonl"), [...native("late", "child", "codex-next"), ...root]);
	write(join(sessions, "retry.jsonl"), native("retry", "child", "codex-next"));
	const childDir = join(cwd, "claude/subagents");
	mkdirSync(childDir, {recursive: true});
	const child = response("claude-child", "a", "claude-first", "spawn-b");
	write(join(childDir, "agent-a.jsonl"), [claudeRoot, child]);
	writeFileSync(join(childDir, "agent-a.meta.json"), JSON.stringify({toolUseId: "spawn-a"}));
	write(join(childDir, "agent-b.jsonl"), [
		claudeRoot,
		child,
		response("claude-nested", "b"),
		response("claude-retry", "b", "claude-next"),
	]);
	writeFileSync(join(childDir, "agent-b.meta.json"), JSON.stringify({toolUseId: "spawn-b"}));
	codex("SessionStart");
	hook("SessionStart");
	const args = ["spend", "rollup", "--ledger", ledger, "--run", runId, "--json"];
	const recovered = JSON.parse(run(args)).usage as ReturnType<typeof rollUpUsage>;
	expect(recovered.responses).toBe(8);
	expect(recovered.byModel.map((row) => [row.model, row.responses])).toEqual([
		["claude-first", 3],
		["claude-next", 1],
		["codex-first", 2],
		["codex-next", 2],
	]);
	const totals = (host: string) =>
		Object.fromEntries(
			recovered.counters.filter((row) => row.host === host).map((row) => [row.field, row.tokens]),
		);
	// Four native Codex responses each report 10 input and 5 output. Cached and reasoning are subsets.
	expect(totals("codex")).toEqual({
		input_tokens: 40,
		cached_input_tokens: 8,
		cache_write_input_tokens: null,
		output_tokens: 20,
		reasoning_output_tokens: 4,
		total_tokens: 60,
		cached_output_tokens: null,
	});
	// Claude reports separate input/cache components. The TTL counts partition the 40 cache writes.
	expect(totals("claude")).toEqual({
		input_tokens: 8,
		output_tokens: 28,
		cache_read_input_tokens: 80,
		cache_creation_input_tokens: 40,
		"cache_creation.ephemeral_5m_input_tokens": 24,
		"cache_creation.ephemeral_1h_input_tokens": 16,
		cached_output_tokens: null,
	});
	expect(recovered.excluded.cumulative).toBe(8);
	expect(recovered.coverage.state).toBe("partial");
	expect(recovered.coverage.groups.flatMap((group) => group.missing)).not.toContain("late");
	const before = readFileSync(ledger, "utf8");
	codex("Stop");
	hook("Stop");
	expect(readFileSync(ledger, "utf8")).toBe(before);
	expect(JSON.parse(run(args)).usage).toEqual(recovered);
	expect(JSON.parse(run(["spend", "read", "--ledger", ledger, "--json"])).usage.counters).toEqual(
		recovered.counters,
	);
	write(transcript, [claudeRoot, {...response("unbound"), gitBranch: "main"}]);
	hook("Stop");
	const overall = JSON.parse(run(args)).usage as ReturnType<typeof rollUpUsage>;
	expect(overall.responses).toBe(9);
	expect(overall.unattributed.responses).toBe(1);
	const issue = JSON.parse(
		run(["spend", "rollup", "--ledger", ledger, "--issue", "8952", "--json"]),
	).usage as ReturnType<typeof rollUpUsage>;
	expect(issue.responses).toBe(8);
	expect(issue.excluded.unattributed).toBe(1);
}, 30_000);
