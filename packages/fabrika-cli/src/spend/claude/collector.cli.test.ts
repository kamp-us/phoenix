import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import {argvOf, declaredHooks} from "../../hook/declaration.ts";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../../test-budget.ts";
import {readUsageLedger} from "../usage-ledger.ts";

const cli = fileURLToPath(new URL("../../bin.ts", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
const setup = () => {
	const dir = mkdtempSync(join(tmpdir(), "claude-spend-"));
	dirs.push(dir);
	return {
		dir,
		transcript: join(dir, "native.jsonl"),
		ledger: join(dir, ".fabrika/spend-ledger.jsonl"),
	};
};
const response = (id: string, extra = {}) => ({
	type: "assistant",
	sessionId: "native",
	version: "2.1.217",
	uuid: `uuid-${id}`,
	gitBranch: "build/8949-claude-spend-12345678",
	message: {
		id,
		role: "assistant",
		model: "claude-fixture",
		usage: {
			input_tokens: 2,
			output_tokens: 7,
			cache_read_input_tokens: 20,
			cache_creation_input_tokens: 10,
			cache_creation: {ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4},
		},
	},
	...extra,
});
const write = (path: string, rows: unknown[]) =>
	writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
const hook = (s: ReturnType<typeof setup>, event: string, extra = {}, env = {}) =>
	spawnSync(process.execPath, [cli, "hook", "claude-spend"], {
		cwd: s.dir,
		encoding: "utf8",
		env: {
			...process.env,
			FABRIKA_SKIP_INFER: "1",
			FABRIKA_SESSION_ID: "",
			CLAUDE_PIPELINE_REPO: "fixture/repo",
			...env,
		},
		input: JSON.stringify({
			session_id: "native",
			transcript_path: s.transcript,
			cwd: s.dir,
			hook_event_name: event,
			...extra,
		}),
	});
const read = (s: ReturnType<typeof setup>) => readUsageLedger(readFileSync(s.ledger, "utf8"));

describe("Claude collector CLI", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("collects interactive native responses with additive cache counters and TTL subsets", () => {
		const s = setup();
		write(s.transcript, [response("msg-1"), response("msg-1")]);
		const result = hook(s, "SessionStart");
		expect(result.status, result.stderr).toBe(0);
		const rows = read(s).records.filter((row) => row.kind === "measurement");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			work: {issue: 8949, run: "native"},
			agent: {session: "native", parent: {kind: "root"}},
			model: "claude-fixture",
		});
		expect(rows[0]?.counters).toContainEqual({
			field: "cache_creation.ephemeral_1h_input_tokens",
			category: "cacheWrite1h",
			value: {state: "measured", tokens: 4},
			meaning: {kind: "subset", of: "cache_creation_input_tokens"},
		});
		expect(rows[0]?.counters).toContainEqual({
			field: "cached_output_tokens",
			category: "cachedOutput",
			value: {state: "unsupported"},
			meaning: {kind: "unknown"},
		});
	});

	it("collects dispatched nested descendants, ignores inherited history, and retains retry/model switches", () => {
		const s = setup();
		const childDir = join(s.dir, "native/subagents");
		mkdirSync(childDir, {recursive: true});
		const root = response("root", {
			message: {
				...response("root").message,
				content: [{type: "tool_use", id: "spawn-a", name: "Agent", input: {prompt: "PRIVATE"}}],
			},
		});
		const child = response("child", {
			agentId: "a",
			message: {
				...response("child").message,
				content: [{type: "tool_use", id: "spawn-b", name: "Agent"}],
			},
		});
		write(s.transcript, [root]);
		write(join(childDir, "agent-a.jsonl"), [root, child]);
		writeFileSync(
			join(childDir, "agent-a.meta.json"),
			JSON.stringify({toolUseId: "spawn-a", spawnDepth: 1}),
		);
		write(join(childDir, "agent-b.jsonl"), [
			root,
			child,
			response("retry-1", {agentId: "b"}),
			response("retry-2", {
				agentId: "b",
				message: {...response("retry-2").message, model: "other-model"},
			}),
		]);
		writeFileSync(
			join(childDir, "agent-b.meta.json"),
			JSON.stringify({toolUseId: "spawn-b", spawnDepth: 2}),
		);
		const env = {FABRIKA_SESSION_ID: "driver-run"};
		expect(hook(s, "SessionStart", {}, env).status).toBe(0);
		const result = hook(s, "Stop", {}, env);
		expect(result.status, result.stderr).toBe(0);
		expect(hook(s, "Stop", {}, env).status).toBe(0);
		const readback = read(s);
		expect(readback.diagnostics.conflicts).toBe(0);
		const rows = readback.records.filter((row) => row.kind === "measurement");
		expect(rows).toHaveLength(4);
		expect(rows.every((row) => row.work.run === "driver-run")).toBe(true);
		expect(rows.find((row) => row.response === "retry-2")).toMatchObject({
			model: "other-model",
			agent: {session: "native/agent/b", parent: {kind: "known", session: "native/agent/a"}},
		});
		expect(readFileSync(s.ledger, "utf8")).not.toContain("PRIVATE");
	});

	it("persists starts before interruption and recovers missing descendants on a later hook", () => {
		const s = setup();
		write(s.transcript, [
			response("root", {
				message: {
					...response("root").message,
					content: [{type: "tool_use", id: "spawn-late", name: "Agent"}],
				},
			}),
		]);
		const start = hook(s, "SubagentStart", {agent_id: "late", agent_type: "Explore"});
		expect(start.status, start.stderr).toBe(0);
		expect(start.stderr).toContain("incomplete");
		expect(read(s).records).toContainEqual(
			expect.objectContaining({
				kind: "participant",
				participant: "native/agent/late",
				state: "absent",
			}),
		);
		expect(read(s).records.some((row) => row.kind === "coverage" && row.state === "complete")).toBe(
			false,
		);
		const dir = join(s.dir, "native/subagents");
		mkdirSync(dir, {recursive: true});
		write(join(dir, "agent-late.jsonl"), [response("late", {agentId: "late"})]);
		writeFileSync(
			join(dir, "agent-late.meta.json"),
			JSON.stringify({toolUseId: "spawn-late", spawnDepth: 1}),
		);
		const recovered = hook(s, "SessionStart");
		expect(recovered.status, recovered.stderr).toBe(0);
		expect(read(s).records.filter((row) => row.kind === "measurement")).toHaveLength(2);
		const before = readFileSync(s.ledger, "utf8");
		expect(hook(s, "SessionStart").status).toBe(0);
		expect(readFileSync(s.ledger, "utf8")).toBe(before);
	});

	it("runs the installed hooks with native-shaped envelopes and never changes settings or decisions", () => {
		const s = setup();
		write(s.transcript, [response("root")]);
		const settings = join(s.dir, "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({model: "native-choice", permissions: {defaultMode: "plan"}}),
		);
		const before = readFileSync(settings, "utf8");
		const declarations = declaredHooks(
			JSON.parse(
				readFileSync(
					new URL("../../../../../claude-plugins/fabrika/hooks.json", import.meta.url),
					"utf8",
				),
			),
		).filter((row) => row.command === "fabrika hook claude-spend");
		expect(declarations.map((row) => row.event)).toEqual(
			expect.arrayContaining([
				"SessionStart",
				"SubagentStart",
				"SubagentStop",
				"Stop",
				"StopFailure",
				"SessionEnd",
				"PostToolUse",
			]),
		);
		for (const declared of declarations) {
			const result = spawnSync(process.execPath, [cli, ...argvOf(declared.command)], {
				cwd: s.dir,
				encoding: "utf8",
				env: {...process.env, FABRIKA_SKIP_INFER: "1"},
				input: JSON.stringify({
					session_id: "native",
					transcript_path: s.transcript,
					cwd: s.dir,
					hook_event_name: declared.event,
					permission_mode: "plan",
					model: "native-choice",
					agent_id: "child",
					agent_type: "Explore",
					agent_transcript_path: join(s.dir, "missing.jsonl"),
					stop_hook_active: false,
					prompt: "PRIVATE",
					last_assistant_message: "PRIVATE",
				}),
			});
			expect(result.status, result.stderr).toBe(0);
			expect(Object.keys(JSON.parse(result.stdout))).toEqual(["systemMessage"]);
		}
		expect(readFileSync(settings, "utf8")).toBe(before);
		expect(readFileSync(s.ledger, "utf8")).not.toContain("PRIVATE");
	});

	it("keeps failed recording visible, exits successfully, and recovers after IO is restored", () => {
		const s = setup();
		write(s.transcript, [response("root")]);
		mkdirSync(join(s.dir, ".fabrika"));
		writeFileSync(join(s.dir, ".fabrika/claude-usage"), "not a directory");
		const failed = hook(s, "StopFailure");
		expect(failed.status).toBe(0);
		expect(failed.stderr).toContain("collector failed");
		expect(JSON.parse(failed.stdout).systemMessage).toContain("collector failed");
		rmSync(join(s.dir, ".fabrika/claude-usage"));
		expect(hook(s, "SessionStart").status).toBe(0);
		expect(read(s).records.filter((row) => row.kind === "measurement")).toHaveLength(1);
	});

	it("reads the metadata projection of recorded Claude 2.1.217 response fragments", () => {
		const s = setup();
		const fixture = readFileSync(
			new URL("./fixtures/native-2.1.217.jsonl", import.meta.url),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const dir = join(s.dir, "native/subagents");
		mkdirSync(dir, {recursive: true});
		write(s.transcript, [
			response("root", {
				message: {
					...response("root").message,
					content: [{type: "tool_use", id: "spawn-a", name: "Agent"}],
				},
			}),
		]);
		write(
			join(dir, "agent-a.jsonl"),
			fixture.map((row) => ({...row, sessionId: "native", agentId: "a"})),
		);
		writeFileSync(join(dir, "agent-a.meta.json"), JSON.stringify({toolUseId: "spawn-a"}));
		const result = hook(s, "SubagentStop", {
			agent_id: "a",
			agent_transcript_path: join(dir, "agent-a.jsonl"),
		});
		expect(result.status, result.stderr).toBe(0);
		const rows = read(s)
			.records.filter((row) => row.kind === "measurement")
			.filter((row) => row.agent.nativeSession === "a");
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.source.version === "2.1.217")).toBe(true);
		expect(
			rows.map((row) => row.counters.find((counter) => counter.category === "output")?.value),
		).toEqual([
			{state: "measured", tokens: 2},
			{state: "measured", tokens: 80},
		]);
	});

	it("retains an unmatched native Agent call when interruption loses the child-start hook", () => {
		const s = setup();
		write(s.transcript, [
			response("root", {
				message: {
					...response("root").message,
					content: [{type: "tool_use", id: "lost-start", name: "Agent"}],
				},
			}),
		]);
		const result = hook(s, "StopFailure");
		expect(result.status, result.stderr).toBe(0);
		expect(read(s).records).toContainEqual(
			expect.objectContaining({
				kind: "participant",
				participant: "native/tool/lost-start",
				state: "expected",
			}),
		);
	});

	it("distinguishes zero, absent and invalid counters and reports a response with missing usage", () => {
		const s = setup();
		write(s.transcript, [
			response("sparse", {
				message: {
					...response("sparse").message,
					usage: {input_tokens: 0, output_tokens: -1, cache_creation: "invalid"},
				},
			}),
			response("missing", {message: {id: "missing", role: "assistant", model: "unknown-usage"}}),
		]);
		const result = hook(s, "Stop");
		expect(result.status, result.stderr).toBe(0);
		const row = read(s).records.find((row) => row.kind === "measurement");
		if (row?.kind !== "measurement") throw new Error("expected measurement");
		expect(row.provider).toBeNull();
		expect(row.counters.find((counter) => counter.field === "input_tokens")?.value).toEqual({
			state: "measured",
			tokens: 0,
		});
		expect(row.counters.find((counter) => counter.field === "output_tokens")?.value).toEqual({
			state: "unavailable",
		});
		expect(
			row.counters.find((counter) => counter.field === "cache_read_input_tokens")?.value,
		).toEqual({state: "absent"});
		expect(row.counters.find((counter) => counter.category === "cacheWrite1h")?.value).toEqual({
			state: "unavailable",
		});
		expect(read(s).records).toContainEqual(
			expect.objectContaining({kind: "participant", state: "usage-missing"}),
		);
	});

	it("keeps a stopped child's explicit transcript path when its start supplied only an ID", () => {
		const s = setup();
		write(s.transcript, [
			response("root", {
				message: {
					...response("root").message,
					content: [{type: "tool_use", id: "spawn-external", name: "Agent"}],
				},
			}),
		]);
		expect(hook(s, "SubagentStart", {agent_id: "external"}).status).toBe(0);
		const defaults = join(s.dir, "native/subagents");
		mkdirSync(defaults, {recursive: true});
		write(join(defaults, "agent-external.jsonl"), [response("old", {agentId: "external"})]);
		const file = join(s.dir, "elsewhere.jsonl");
		write(file, [response("external", {agentId: "external"})]);
		writeFileSync(
			join(s.dir, "elsewhere.meta.json"),
			JSON.stringify({toolUseId: "spawn-external"}),
		);
		expect(
			hook(s, "SubagentStop", {agent_id: "external", agent_transcript_path: file}).status,
		).toBe(0);
		expect(hook(s, "SubagentStart", {agent_id: "external"}).status).toBe(0);
		expect(read(s).records.filter((row) => row.kind === "measurement")).toHaveLength(2);
		expect(
			read(s)
				.records.filter((row) => row.kind === "measurement")
				.map((row) => row.response),
		).toEqual(["root", "external"]);
		const before = readFileSync(s.ledger, "utf8");
		expect(hook(s, "SessionStart").status).toBe(0);
		expect(readFileSync(s.ledger, "utf8")).toBe(before);
	});
});
