import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const run = (
	args: ReadonlyArray<string>,
	stdin: string,
	env: NodeJS.ProcessEnv = {},
): Promise<RunResult> =>
	new Promise((resolve) => {
		// Drop a WORKFLOW_MODEL inherited from the runner so a "no pin" case can't silently
		// pick one up from the harness env; explicit `env` entries below still win.
		const {WORKFLOW_MODEL: _drop, ...base} = process.env;
		const child = execFile(
			"node",
			[BIN, ...args],
			{env: {...base, ...env}},
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as {code?: unknown}).code === "number"
						? (error as {code: number}).code
						: 0;
				resolve({code, stdout, stderr});
			},
		);
		child.stdin?.end(stdin);
	});

const envelope = (model: string | null): string =>
	JSON.stringify({
		hook_event_name: "PreToolUse",
		tool_name: "Task",
		tool_input: model === null ? {prompt: "x"} : {prompt: "x", model},
	});

describe("guard CLI — PreToolUse envelope", () => {
	it("ALLOWS an allowlisted requested model", async () => {
		const {stdout} = await run(["guard"], envelope("claude-opus-4-8"));
		const out = JSON.parse(stdout);
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "allow");
		assert.notProperty(out.hookSpecificOutput, "updatedInput");
	}, 30_000);

	it("DENIES an off-allowlist model with no pin and emits what it checked (ADR 0092)", async () => {
		const {stdout} = await run(["guard"], envelope("claude-fable-5"));
		const out = JSON.parse(stdout);
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
		assert.include(out.hookSpecificOutput.permissionDecisionReason, "allowlist=[");
		assert.include(out.hookSpecificOutput.permissionDecisionReason, "claude-fable-5");
	}, 30_000);

	it("DENIES an unset model with no pin (fail-closed on absent)", async () => {
		const {stdout} = await run(["guard"], envelope(null));
		assert.strictEqual(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "deny");
	}, 30_000);

	it("ALLOWS an unset model with an allowlisted pin WITHOUT rewriting it (#776: inherit the session model — the Task tool's `model` accepts only short names, so injecting the full pin id failed the schema and blocked every spawn)", async () => {
		const {stdout} = await run(["guard"], envelope(null), {WORKFLOW_MODEL: "claude-opus-4-8"});
		const out = JSON.parse(stdout);
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, "allow");
		assert.notProperty(out.hookSpecificOutput, "updatedInput");
	}, 30_000);

	it("DENIES even with a pin set when the pin itself is off-allowlist", async () => {
		const {stdout} = await run(["guard"], envelope("claude-fable-5"), {
			WORKFLOW_MODEL: "claude-sonnet-4-6",
		});
		assert.strictEqual(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "deny");
	}, 30_000);
});

describe("statusline CLI — statusLine payload", () => {
	it("renders model · cost · tokens from a Claude Code statusLine payload", async () => {
		const payload = JSON.stringify({
			model: {id: "claude-opus-4-8"},
			cost: {total_cost_usd: 0.42, total_tokens: 31_000},
		});
		const {stdout} = await run(["statusline"], payload);
		assert.strictEqual(stdout.trim(), "claude-opus-4-8 · $0.42 · 31.0K tok");
	}, 30_000);

	it("degrades to 'cost n/a' on an empty/garbage frame (never blanks the statusline)", async () => {
		const {stdout, code} = await run(["statusline"], "not json");
		assert.strictEqual(code, 0);
		assert.strictEqual(stdout.trim(), "cost n/a");
	}, 30_000);
});
