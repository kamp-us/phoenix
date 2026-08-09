import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {StdinRead} from "../io/stdin.ts";
import {EMPTY_STDIN, ENVELOPE_UNKNOWN, MALFORMED_ENVELOPE, WRONG_EVENT} from "./codes.ts";
import {runSpawn} from "./spawn-verb.ts";

const spawn = (piped: StdinRead, pin: string | null = null) =>
	Effect.runSync(runSpawn({stdin: Effect.succeed(piped), pin}));

const envelope = (extra: Record<string, unknown>): StdinRead => ({
	_tag: "Text",
	text: JSON.stringify({
		hook_event_name: "PreToolUse",
		session_id: "s",
		transcript_path: "t",
		cwd: "/c",
		...extra,
	}),
});

describe("hook spawn", () => {
	it("emits the permission decision the harness reads", () => {
		const outcome = spawn(envelope({tool_name: "Agent", tool_input: {model: "opus"}}));
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).hookSpecificOutput).toMatchObject({
			hookEventName: "PreToolUse",
			permissionDecision: "allow",
		});
	});

	it("denies an off-allowlist spawn", () => {
		const outcome = spawn(envelope({tool_input: {model: "fable-5"}}));
		expect(JSON.parse(outcome.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
	});

	it("states the scope it judged, including the pin, on the answer path too", () => {
		expect(spawn(envelope({tool_input: {}}), "claude-opus-4-8").stderr.join("\n")).toContain(
			"WORKFLOW_MODEL=claude-opus-4-8",
		);
	});

	it.each([
		["an empty pipe", {_tag: "Text", text: ""} as StdinRead, EMPTY_STDIN],
		["bytes that are not an envelope", {_tag: "Text", text: "{}"} as StdinRead, MALFORMED_ENVELOPE],
		["a TTY", {_tag: "NoStdin", reason: "fd 0 is a TTY"} as StdinRead, ENVELOPE_UNKNOWN],
		["a failed read", {_tag: "Failed", reason: "EAGAIN"} as StdinRead, ENVELOPE_UNKNOWN],
	])("refuses %s with nothing on stdout", (_label, piped, code) => {
		const outcome = spawn(piped);
		expect(outcome.code).toBe(code);
		expect(outcome.stdout).toBe("");
	});

	it("refuses an event it does not judge without calling it malformed", () => {
		const outcome = spawn({
			_tag: "Text",
			text: JSON.stringify({
				hook_event_name: "SessionStart",
				session_id: "s",
				transcript_path: "t",
				cwd: "/c",
			}),
		});
		expect(outcome.code).toBe(WRONG_EVENT);
		expect(outcome.stdout).toBe("");
	});
});
