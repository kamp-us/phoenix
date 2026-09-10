import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {readUsageLedger} from "./usage-ledger.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
describe("installed repository Codex hook entry", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("runs the documented hook command with native JSON and advisory storage failures", () => {
		const cwd = mkdtempSync(join(tmpdir(), "codex-hook-cli-"));
		dirs.push(cwd);
		execFileSync("git", ["init", "--quiet"], {cwd});
		mkdirSync(join(cwd, "packages"));
		symlinkSync(
			fileURLToPath(new URL("../../", import.meta.url)),
			join(cwd, "packages", "fabrika-cli"),
		);
		const home = join(cwd, "codex");
		const sessions = join(home, "sessions");
		mkdirSync(sessions, {recursive: true});
		const transcript = join(sessions, "native.jsonl");
		const usage = {
			input_tokens: 10,
			cached_input_tokens: 2,
			output_tokens: 5,
			reasoning_output_tokens: 1,
			total_tokens: 15,
		};
		writeFileSync(
			transcript,
			[
				{
					type: "session_meta",
					payload: {
						id: "native",
						session_id: "native",
						cli_version: "0.153.4",
						model_provider: "openai",
					},
				},
				{type: "turn_context", payload: {turn_id: "turn", model: "model"}},
				{
					type: "event_msg",
					payload: {
						type: "token_usage_record",
						thread_id: "native",
						session_id: "native",
						turn_id: "turn",
						root_turn_id: "turn",
						response_id: "r",
						usage,
						turn_token_usage: usage,
						thread_token_usage: usage,
					},
				},
			]
				.map((row) => JSON.stringify(row))
				.join("\n"),
		);
		const config = JSON.parse(
			readFileSync(new URL("../../docs/codex-hooks.json", import.meta.url), "utf8"),
		);
		const event = {
			hook_event_name: "PreToolUse",
			session_id: "native",
			turn_id: "turn",
			transcript_path: transcript,
			cwd,
			tool_input: {cmd: "node packages/fabrika-cli/src/bin.ts build claim 8950"},
		};
		const run = (input: unknown) =>
			JSON.parse(
				execFileSync("/bin/sh", ["-c", config.hooks.PreToolUse[0].hooks[0].command], {
					cwd,
					env: {...process.env, CODEX_HOME: home},
					input: JSON.stringify(input),
					encoding: "utf8",
				}),
			);
		const ledger = join(cwd, ".fabrika", "spend-ledger.jsonl");
		mkdirSync(ledger, {recursive: true});
		expect(run(event)).toHaveProperty("systemMessage");
		rmSync(ledger, {recursive: true});
		expect(run(event)).toEqual({});
		expect(run({...event, hook_event_name: "Stop"})).toEqual({});
		const read = readUsageLedger(readFileSync(ledger, "utf8"));
		expect(read.records.filter((row) => row.kind === "measurement")).toHaveLength(3);
		expect(read.diagnostics.conflicts).toBe(0);
		expect(run({})).toHaveProperty("systemMessage");
	});
});
