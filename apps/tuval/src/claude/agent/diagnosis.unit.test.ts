/**
 * The diagnosis table, read against the stamps `@anthropic-ai/claude-agent-sdk@0.3.259` actually
 * writes (`sdk.mjs`). Each `stamped` row below is the shape the bundle produces for that failure;
 * the `null` rows are the positive controls that prove the table can decline to diagnose.
 */

import {assert, describe, it} from "vitest";
import {diagnose} from "./diagnosis.ts";

const stamped = (message: string, props: Record<string, unknown>): Error =>
	Object.assign(new Error(message), props);

describe("a cause the SDK stamped", () => {
	it("reads an executable it could not find as an install problem", () => {
		const answer = diagnose(
			stamped("Claude Code native binary not found at /nope/claude.", {
				errorClass: "executable_not_found",
				code: "ENOENT",
			}),
		);
		assert.strictEqual(answer, "Claude Code is not installed where this session looked for it");
	});

	it("reads a binary that will not launch as a platform problem", () => {
		assert.include(
			diagnose(stamped("exists but failed to launch", {errorClass: "executable_launch_failed"})) ??
				"",
			"will not run on this machine",
		);
	});

	it("passes on the CLI's own authentication and network hint for a startup timeout", () => {
		assert.include(
			diagnose(stamped("did not complete within 30000ms", {errorClass: "initialize_timeout"})) ??
				"",
			"authentication and network",
		);
	});

	it("names the exit code off the stamp rather than off the message", () => {
		assert.strictEqual(
			diagnose(
				stamped("Claude Code process exited with code 1. stderr: /Users/founder/.credentials", {
					errorClass: "process_exited_nonzero",
					exitCode: 1,
				}),
			),
			"the Claude Code CLI exited with code 1",
		);
	});

	it("still answers for a non-zero exit whose code did not come through", () => {
		assert.strictEqual(
			diagnose(stamped("exited", {errorClass: "process_exited_nonzero"})),
			"the Claude Code CLI exited before it answered",
		);
	});

	it("reads a signal kill", () => {
		assert.include(
			diagnose(stamped("terminated by signal SIGKILL", {errorClass: "process_killed_by_signal"})) ??
				"",
			"was killed",
		);
	});
});

describe("a cause carrying no diagnosis", () => {
	it("declines the two classes whose message is CLI or model text", () => {
		assert.isNull(
			diagnose(stamped("whatever the CLI said", {errorClass: "control_request_failed"})),
		);
		assert.isNull(diagnose(stamped("whatever the model said", {errorClass: "error_result"})));
	});

	it("declines a stamp this table does not know", () => {
		assert.isNull(diagnose(stamped("something new", {errorClass: "some_future_class"})));
	});

	it("declines a plain Error, a string and a nullish throw", () => {
		assert.isNull(diagnose(new Error("ECONNRESET")));
		assert.isNull(diagnose("a thrown string"));
		assert.isNull(diagnose(null));
		assert.isNull(diagnose(undefined));
	});
});

describe("the one reading taken off message text", () => {
	it("catches the setup throw the SDK leaves unstamped", () => {
		assert.include(
			diagnose(
				new Error(
					"Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.",
				),
			) ?? "",
			"not installed for this platform",
		);
	});
});
