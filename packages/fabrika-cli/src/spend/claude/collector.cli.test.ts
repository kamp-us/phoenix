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
});
