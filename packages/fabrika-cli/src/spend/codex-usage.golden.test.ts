import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {afterEach, expect, it} from "vitest";
import {readGoldenFixture} from "../golden-fixture.ts";
import {runCodexHook} from "./codex-hook-verb.ts";
import {readCodexSession} from "./codex-records.ts";
import {readUsageLedger} from "./usage-ledger.ts";
import {rollUpUsage} from "./usage-rollup.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

it("persists captured native usage before issue resolution and replays it without double counting", async () => {
	const captured = readGoldenFixture(
		import.meta.url,
		"__fixtures__/codex-token-usage.golden.jsonl",
	);
	const session = readCodexSession(captured);
	if (!session) throw new Error("Missing captured session");
	const native = session.rows[2];
	expect(native).toMatchObject({type: "token_usage_record", ordinal: 13});
	expect(native?.payload).not.toHaveProperty("type");
	const dir = mkdtempSync(join(tmpdir(), "codex-usage-golden-"));
	dirs.push(dir);
	const sessions = join(dir, "sessions");
	mkdirSync(sessions);
	const transcript = join(sessions, "native.jsonl");
	writeFileSync(transcript, captured);
	const ledger = join(dir, "ledger.jsonl");
	const event = {
		hook_event_name: "PreToolUse",
		session_id: session.thread,
		turn_id: "captured-id-2",
		transcript_path: transcript,
		cwd: dir,
	};
	const run = (command: string) =>
		Effect.runPromise(
			runCodexHook({
				input: JSON.stringify({...event, tool_input: {command}}),
				sessions,
				state: join(dir, "state"),
				ledger,
				repo: "fixture/repo",
			}).pipe(Effect.provide(NodeServices.layer)),
		);
	expect((await run("fabrika build issue $ISSUE")).code).toBe(0);
	const unbound = readUsageLedger(readFileSync(ledger, "utf8"));
	expect(rollUpUsage(unbound).unattributed.responses).toBe(1);
	const measurements = unbound.records.filter((row) => row.kind === "measurement");
	expect(measurements).toHaveLength(3);
	const response = measurements.find((row) => row.basis.kind === "response");
	expect(response).toMatchObject({
		work: {issue: null, attempt: "captured-id-1"},
		agent: {session: "captured-id-1", nativeSession: "captured-id-1"},
		response: "captured-id-3",
		turn: "captured-id-2",
		rootTurn: "captured-id-2",
		provider: "openai",
		model: "gpt-6-astra",
	});
	expect(response?.counters).toEqual([
		{
			field: "input_tokens",
			category: "input",
			meaning: {kind: "additive"},
			value: {state: "measured", tokens: 22039},
		},
		{
			field: "cached_input_tokens",
			category: "cacheRead",
			meaning: {kind: "subset", of: "input_tokens"},
			value: {state: "measured", tokens: 12160},
		},
		{
			field: "cache_write_input_tokens",
			category: "cacheWrite",
			meaning: {kind: "unknown"},
			value: {state: "measured", tokens: 0},
		},
		{
			field: "output_tokens",
			category: "output",
			meaning: {kind: "additive"},
			value: {state: "measured", tokens: 109},
		},
		{
			field: "reasoning_output_tokens",
			category: "reasoning",
			meaning: {kind: "subset", of: "output_tokens"},
			value: {state: "measured", tokens: 0},
		},
		{
			field: "total_tokens",
			category: "total",
			meaning: {kind: "aggregate", of: ["input_tokens", "output_tokens"]},
			value: {state: "measured", tokens: 22148},
		},
		{
			field: "cached_output_tokens",
			category: "cachedOutput",
			meaning: {kind: "unknown"},
			value: {state: "unsupported"},
		},
	]);
	for (const command of ["fabrika build issue 8892", "fabrika build issue 8892"])
		expect((await run(command)).code).toBe(0);
	const resolved = readUsageLedger(readFileSync(ledger, "utf8"));
	expect(resolved.diagnostics.conflicts).toBe(0);
	expect(resolved.records.filter((row) => row.kind === "measurement")).toHaveLength(3);
	expect(rollUpUsage(resolved, {issue: 8892}).responses).toBe(1);
	expect(rollUpUsage(resolved).unattributed.responses).toBe(0);
	expect(
		resolved.records.filter((row) => row.kind === "measurement").map((row) => row.counters),
	).toEqual(measurements.map((row) => row.counters));
});
