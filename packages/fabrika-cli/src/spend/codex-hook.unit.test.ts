import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {afterEach, expect, it} from "vitest";
import {runCodexHook} from "./codex-hook-verb.ts";
import {readUsageLedger} from "./usage-ledger.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
const live = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));
it("binds interactive work at the native tool callback and collects again at Stop", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-hook-"));
	dirs.push(dir);
	const sessions = join(dir, "sessions");
	mkdirSync(sessions);
	const state = join(dir, "state"),
		ledger = join(dir, "ledger.jsonl"),
		transcript = join(sessions, "root.jsonl");
	const rows: unknown[] = [
		{
			type: "session_meta",
			payload: {
				id: "native",
				session_id: "native",
				cli_version: "0.154.0",
				model_provider: "openai",
			},
		},
		{type: "turn_context", payload: {turn_id: "turn", model: "m"}},
	];
	writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
	const event = {
		session_id: "native",
		turn_id: "turn",
		cwd: dir,
		transcript_path: transcript,
		hook_event_name: "PreToolUse",
		tool_name: "exec_command",
		tool_input: {cmd: "node packages/fabrika-cli/src/bin.ts build claim 8950"},
	};
	const options = {input: JSON.stringify(event), sessions, state, ledger, repo: "o/r"};
	const started = await live(runCodexHook(options));
	expect(started.code).toBe(0);
	const usage = {
		input_tokens: 1,
		cached_input_tokens: 0,
		output_tokens: 2,
		reasoning_output_tokens: 0,
		total_tokens: 3,
	};
	const response = {
		type: "token_usage_record",
		payload: {
			thread_id: "native",
			session_id: "native",
			turn_id: "turn",
			root_turn_id: "turn",
			response_id: "r",
			usage,
			turn_token_usage: usage,
			thread_token_usage: usage,
		},
	};
	writeFileSync(
		transcript,
		`${rows
			.concat([response])
			.map((row) => JSON.stringify(row))
			.join("\n")}\n`,
	);
	const stopped = await live(
		runCodexHook({
			...options,
			input: JSON.stringify({...event, hook_event_name: "Stop", tool_input: undefined}),
		}),
	);
	expect(stopped.code).toBe(0);
	expect(JSON.parse(stopped.stdout)).not.toHaveProperty("decision");
	await live(
		runCodexHook({...options, input: JSON.stringify({...event, hook_event_name: "Stop"})}),
	);
	const records = readUsageLedger(readFileSync(ledger, "utf8")).records.filter(
		(row) => row.kind === "measurement",
	);
	expect(records).toHaveLength(3);
	expect(records[0]).toMatchObject({
		work: {issue: 8950, run: "codex:native:turn", attempt: "native"},
	});
	writeFileSync(
		transcript,
		`${rows
			.concat([
				response,
				{type: "turn_context", payload: {turn_id: "next-turn", model: "m2"}},
				{
					...response,
					payload: {
						...response.payload,
						turn_id: "next-turn",
						root_turn_id: "next-turn",
						response_id: "r2",
					},
				},
			])
			.map((row) => JSON.stringify(row))
			.join("\n")}\n`,
	);
	await live(
		runCodexHook({
			...options,
			input: JSON.stringify({
				...event,
				turn_id: "next-turn",
				hook_event_name: "Stop",
				tool_input: undefined,
			}),
		}),
	);
	expect(
		readUsageLedger(readFileSync(ledger, "utf8")).records.filter(
			(row) => row.kind === "measurement",
		),
	).toHaveLength(6);
});

it("keeps an unresolved issue warning when the native callback has no turn ID", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-unresolved-"));
	dirs.push(dir);
	const result = await live(
		runCodexHook({
			input: JSON.stringify({
				session_id: "native",
				hook_event_name: "PreToolUse",
				tool_input: {command: "fabrika review criteria $ISSUE"},
			}),
			sessions: join(dir, "sessions"),
			state: join(dir, "state"),
			ledger: join(dir, "ledger"),
			repo: "o/r",
		}),
	);
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).systemMessage).toContain("association is unresolved");
});
