/**
 * The Claude collector's transcript rules, run in-process against a temp directory.
 *
 * The filesystem is real because discovery and the ledger's lock are properties of it. The git
 * reads are scripted to fail, so the collector falls back to the hook's `cwd` and no process runs;
 * the hook's stdin framing and exit status stay proven in `collector.cli.test.ts`.
 */
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect, Layer} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {fakeShell} from "../../fakes.test-support.ts";
import {readUsageLedger} from "../usage-ledger.ts";
import {runClaudeSpend} from "./collector.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
const setup = () => {
	const dir = mkdtempSync(join(tmpdir(), "claude-spend-unit-"));
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
const spawning = (id: string, tool: string, extra = {}) =>
	response(id, {
		message: {...response(id).message, content: [{type: "tool_use", id: tool, name: "Agent"}]},
		...extra,
	});
const write = (path: string, rows: unknown[]) =>
	writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
const collect = (s: ReturnType<typeof setup>, event: string, extra = {}, env = {}) =>
	Effect.runPromise(
		runClaudeSpend({
			stdin: Effect.succeed({
				_tag: "Text",
				text: JSON.stringify({
					session_id: "native",
					transcript_path: s.transcript,
					cwd: s.dir,
					hook_event_name: event,
					...extra,
				}),
			}),
			env: {FABRIKA_SESSION_ID: "", CLAUDE_PIPELINE_REPO: "fixture/repo", ...env},
		}).pipe(Effect.provide(Layer.merge(NodeServices.layer, fakeShell([]).layer))),
	);
const read = (s: ReturnType<typeof setup>) => readUsageLedger(readFileSync(s.ledger, "utf8"));
const measurements = (s: ReturnType<typeof setup>) =>
	read(s).records.filter((row) => row.kind === "measurement");

describe("Claude collector", () => {
	it("collects interactive native responses with additive cache counters and TTL subsets", async () => {
		const s = setup();
		write(s.transcript, [response("msg-1"), response("msg-1")]);
		await collect(s, "SessionStart");
		const rows = measurements(s);
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

	it("collects dispatched nested descendants, ignores inherited history, and retains retry/model switches", async () => {
		const s = setup();
		const childDir = join(s.dir, "native/subagents");
		mkdirSync(childDir, {recursive: true});
		const root = response("root", {
			message: {
				...response("root").message,
				content: [{type: "tool_use", id: "spawn-a", name: "Agent", input: {prompt: "PRIVATE"}}],
			},
		});
		const child = spawning("child", "spawn-b", {agentId: "a"});
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
		await collect(s, "SessionStart", {}, env);
		await collect(s, "Stop", {}, env);
		await collect(s, "Stop", {}, env);
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

	it("reads the metadata projection of recorded Claude 2.1.217 response fragments", async () => {
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
		write(s.transcript, [spawning("root", "spawn-a")]);
		write(
			join(dir, "agent-a.jsonl"),
			fixture.map((row) => ({...row, sessionId: "native", agentId: "a"})),
		);
		writeFileSync(join(dir, "agent-a.meta.json"), JSON.stringify({toolUseId: "spawn-a"}));
		await collect(s, "SubagentStop", {
			agent_id: "a",
			agent_transcript_path: join(dir, "agent-a.jsonl"),
		});
		const rows = measurements(s).filter((row) => row.agent.nativeSession === "a");
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.source.version === "2.1.217")).toBe(true);
		expect(
			rows.map((row) => row.counters.find((counter) => counter.category === "output")?.value),
		).toEqual([
			{state: "measured", tokens: 2},
			{state: "measured", tokens: 80},
		]);
	});

	it("retains an unmatched native Agent call when interruption loses the child-start hook", async () => {
		const s = setup();
		write(s.transcript, [spawning("root", "lost-start")]);
		await collect(s, "StopFailure");
		expect(read(s).records).toContainEqual(
			expect.objectContaining({
				kind: "participant",
				participant: "native/tool/lost-start",
				state: "expected",
			}),
		);
	});

	it("distinguishes zero, absent and invalid counters and reports a response with missing usage", async () => {
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
		await collect(s, "Stop");
		const row = measurements(s)[0];
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

	it("keeps a stopped child's explicit transcript path when its start supplied only an ID", async () => {
		const s = setup();
		write(s.transcript, [spawning("root", "spawn-external")]);
		await collect(s, "SubagentStart", {agent_id: "external"});
		const defaults = join(s.dir, "native/subagents");
		mkdirSync(defaults, {recursive: true});
		write(join(defaults, "agent-external.jsonl"), [response("old", {agentId: "external"})]);
		const file = join(s.dir, "elsewhere.jsonl");
		write(file, [response("external", {agentId: "external"})]);
		writeFileSync(
			join(s.dir, "elsewhere.meta.json"),
			JSON.stringify({toolUseId: "spawn-external"}),
		);
		await collect(s, "SubagentStop", {agent_id: "external", agent_transcript_path: file});
		await collect(s, "SubagentStart", {agent_id: "external"});
		expect(measurements(s).map((row) => row.response)).toEqual(["root", "external"]);
		const before = readFileSync(s.ledger, "utf8");
		await collect(s, "SessionStart");
		expect(readFileSync(s.ledger, "utf8")).toBe(before);
	});
});
