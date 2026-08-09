import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {StdinRead} from "../io/stdin.ts";
import {runCheck} from "./check-verb.ts";
import {EMPTY_STDIN, ENVELOPE_UNKNOWN, MALFORMED_ENVELOPE} from "./codes.ts";

const check = (piped: StdinRead, json = false) =>
	Effect.runSync(runCheck({json, stdin: Effect.succeed(piped)}));

const envelope = JSON.stringify({
	hook_event_name: "SessionStart",
	session_id: "s",
	transcript_path: "t",
	cwd: "/c",
	source: "startup",
});

describe("hook check", () => {
	it("answers with a positive token, never with silence", () => {
		const outcome = check({_tag: "Text", text: envelope});
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("conforms\tSessionStart\t5\n");
	});

	it("emits the object shape under --json", () => {
		expect(check({_tag: "Text", text: envelope}, true).stdout).toBe(
			'{"outcome":"conforms","event":"SessionStart","fields":5}\n',
		);
	});

	it("states the scope it judged on the answer path too, not only on refusals", () => {
		expect(check({_tag: "Text", text: envelope}).stderr).toContain(
			`fabrika hook check: judged ${envelope.length} bytes on fd 0`,
		);
	});

	it.each([
		["an empty pipe", {_tag: "Text", text: ""} as StdinRead, EMPTY_STDIN],
		["bytes that are not an envelope", {_tag: "Text", text: "{}"} as StdinRead, MALFORMED_ENVELOPE],
		["a TTY", {_tag: "NoStdin", reason: "fd 0 is a TTY"} as StdinRead, ENVELOPE_UNKNOWN],
		["a failed read", {_tag: "Failed", reason: "EAGAIN"} as StdinRead, ENVELOPE_UNKNOWN],
	])("seats %s on its own code, with nothing on stdout", (_label, piped, code) => {
		const outcome = check(piped);
		expect(outcome.code).toBe(code);
		expect(outcome.stdout).toBe("");
	});

	it("keeps an unread fd 0 apart from a bad payload — the two must never share a code", () => {
		expect(ENVELOPE_UNKNOWN).not.toBe(MALFORMED_ENVELOPE);
	});
});
