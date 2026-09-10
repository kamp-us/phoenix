import {execFileSync} from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {readUsageLedger} from "./usage-ledger.ts";
import {rollUpUsage} from "./usage-rollup.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
describe("installed repository Codex hook entry", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it.each([
		"node packages/fabrika-cli/src/bin.ts build claim 8950",
		"node packages/fabrika-cli/src/bin.ts review criteria --repo fixture/repo 8950",
		"git status --short\nnode packages/fabrika-cli/src/bin.ts review criteria 8950",
		"git status --short && node 'packages/fabrika-cli/src/bin.ts' review criteria --json --repo='fixture/repo' 8950",
		"node packages/fabrika-cli/src/bin.ts build claim --repo fixture/repo --issue=8950 9000",
	])("records native usage through the installed hook for %s", (command) => {
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
			tool_input: {command},
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
		const unknown = {...event, tool_input: {command: "fabrika review criteria $ISSUE"}};
		expect(run(unknown).systemMessage).toContain("association");
		expect(
			run({...unknown, hook_event_name: "Stop", tool_input: undefined}).systemMessage,
		).toContain("association");
		const unbound = readUsageLedger(readFileSync(ledger, "utf8"));
		expect(rollUpUsage(unbound).responses).toBe(1);
		expect(rollUpUsage(unbound).unattributed.responses).toBe(1);
		renameSync(ledger, `${ledger}.saved`);
		mkdirSync(ledger, {recursive: true});
		expect(run(event)).toHaveProperty("systemMessage");
		rmSync(ledger, {recursive: true});
		renameSync(`${ledger}.saved`, ledger);
		expect(run(event)).toEqual({});
		expect(run({...event, hook_event_name: "Stop"})).toEqual({});
		const read = readUsageLedger(readFileSync(ledger, "utf8"));
		expect(read.records.filter((row) => row.kind === "measurement")).toHaveLength(3);
		expect(read.records.filter((row) => row.kind === "measurement")[0]).toMatchObject({
			work: {issue: 8950, run: "codex:native:turn"},
		});
		expect(read.diagnostics.conflicts).toBe(0);
		const next = {
			...event,
			turn_id: "next",
			tool_input: {command: "fabrika review criteria $ISSUE"},
		};
		const original = readFileSync(transcript, "utf8");
		writeFileSync(
			transcript,
			original +
				"\n" +
				original
					.split("\n")
					.slice(1)
					.join("\n")
					.replaceAll('"turn"', '"next"')
					.replaceAll('"r"', '"r2"'),
		);
		expect(run(next).systemMessage).toContain("association");
		expect(run({...next, hook_event_name: "Stop", tool_input: undefined}).systemMessage).toContain(
			"association",
		);
		const pending = readUsageLedger(readFileSync(ledger, "utf8"));
		expect(pending.records.filter((row) => row.kind === "measurement")).toHaveLength(6);
		expect(rollUpUsage(pending).responses).toBe(2);
		expect(rollUpUsage(pending).unattributed.responses).toBe(1);
		expect(rollUpUsage(pending, {run: "codex:native:next"}).responses).toBe(1);
		expect(rollUpUsage(pending, {run: "codex:native:next"}).unattributed.responses).toBe(1);
		expect(
			run({...next, tool_input: {command: "fabrika review criteria --repo=o/r 8951"}}),
		).toEqual({});
		expect(
			readUsageLedger(readFileSync(ledger, "utf8")).records.filter(
				(row) => row.kind === "measurement",
			),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					work: expect.objectContaining({issue: 8951, run: "codex:native:next"}),
				}),
			]),
		);
		const resolved = readUsageLedger(readFileSync(ledger, "utf8"));
		expect(rollUpUsage(resolved).responses).toBe(2);
		expect(rollUpUsage(resolved).unattributed.responses).toBe(0);
		expect(resolved.diagnostics.conflicts).toBe(0);
		expect(run({})).toHaveProperty("systemMessage");
		expect(run(next).systemMessage).toContain("association");
		expect(
			run({...next, tool_input: {command: "fabrika review criteria 8952"}}).systemMessage,
		).toContain("Multiple issues");
	});
});
