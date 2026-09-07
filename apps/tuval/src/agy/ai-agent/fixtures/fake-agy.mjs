#!/usr/bin/env node
/**
 * A scripted stand-in for the `agy` binary, replaying captured v1.1.27 NDJSON.
 *
 * `agy` is not on CI and never will be, so the integration tier drives this instead — the shape
 * #7625 established for the Claude row: scripted in CI, the real CLI on the founder's machine. It
 * is plain `.mjs` rather than TypeScript because it is spawned as an executable by path, exactly as
 * the real binary is, so nothing may stand between it and `execve`.
 *
 * What it is faithful to, and only this:
 *
 * - Go-style flags (`--flag=value`), with `--print` required and legitimately empty.
 * - `--print=/<command>` is a whole separate CLI-side invocation answering one flat JSON object
 *   with the catalog under `command.data`, `conversation_id: ""` and zero usage.
 * - A session emits `init` with `conversation_id` at the *top* level, then `step_update` and
 *   `result` with theirs nested inside the payload.
 * - `--conversation=<id>` returns that same id, which is what makes resume a resume.
 * - SIGINT emits a well-formed terminal `result` with `status: "ERROR"` and
 *   `error: "timeout waiting for response"`, then exits 1. There is no `INTERRUPTED` status,
 *   because the real binary never emits one either (ADR 0362).
 *
 * Every invocation appends its argv to `$AGY_FAKE_LOG` as one JSON line, which is how a test
 * asserts a composed argv against the thing that actually received it.
 */

import {appendFileSync} from "node:fs";

const argv = process.argv.slice(2);

const log = process.env.AGY_FAKE_LOG;
if (log !== undefined) appendFileSync(log, `${JSON.stringify(argv)}\n`);

const flagValue = (name) => {
	const found = argv.find((token) => token.startsWith(`${name}=`));
	return found === undefined ? undefined : found.slice(name.length + 1);
};

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Captured verbatim from `agy --print='/help' --output-format=json` at v1.1.27. */
const HELP = {
	conversation_id: "",
	status: "SUCCESS",
	response: "/effort\tSet the reasoning effort\n/help\tShow available commands and keybindings\n",
	duration_seconds: 0,
	num_turns: 0,
	usage: {
		input_tokens: 0,
		output_tokens: 0,
		thinking_tokens: 0,
		cache_read_tokens: 0,
		total_tokens: 0,
	},
	command: {
		name: "help",
		data: {
			commands: [
				{name: "effort", description: "Set the reasoning effort"},
				{name: "help", description: "Show available commands and keybindings"},
				{name: "config", aliases: ["settings"], description: "Open settings panel"},
			],
		},
	},
};

const print = flagValue("--print") ?? "";
if (print.startsWith("/")) {
	write(HELP);
	process.exit(0);
}

const conversationId = flagValue("--conversation") ?? "fake-0000-1111-2222";

/** How long a turn withholds its first byte, so "returned at the send" is observable rather than raced. */
const TURN_DELAY_MS = Number(process.env.AGY_FAKE_TURN_DELAY_MS ?? "300");

write({
	event: "init",
	conversation_id: conversationId,
	init: {
		model: flagValue("--model") ?? undefined,
		cwd: flagValue("--add-dir"),
		tools: ["view_file", "write_to_file"],
		permission_mode: argv.includes("--sandbox") ? "proceed-in-sandbox" : "request-review",
	},
});

process.on("SIGINT", () => {
	write({
		event: "result",
		result: {
			conversation_id: conversationId,
			status: "ERROR",
			response: "",
			error: "timeout waiting for response",
			num_turns: 1,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				thinking_tokens: 0,
				cache_read_tokens: 0,
				total_tokens: 0,
			},
		},
	});
	process.exit(1);
});

let stepIndex = 0;

const runTurn = async (content) => {
	await sleep(TURN_DELAY_MS);
	const index = stepIndex;
	stepIndex += 2;
	write({
		event: "step_update",
		step_update: {
			conversation_id: conversationId,
			step_index: index,
			state: "DONE",
			step_type: "user_input",
		},
	});
	write({
		event: "step_update",
		step_update: {
			conversation_id: conversationId,
			step_index: index + 1,
			state: "ACTIVE",
			step_type: "agent_response",
			text_delta: "you said ",
		},
	});
	await sleep(20);
	write({
		event: "step_update",
		step_update: {
			conversation_id: conversationId,
			step_index: index + 1,
			state: "DONE",
			step_type: "agent_response",
			text_delta: content,
			usage: {
				input_tokens: 7,
				output_tokens: 3,
				thinking_tokens: 0,
				cache_read_tokens: 0,
				total_tokens: 10,
			},
		},
	});
	write({
		event: "result",
		result: {
			conversation_id: conversationId,
			status: "SUCCESS",
			response: `you said ${content}`,
			num_turns: 1,
			usage: {
				input_tokens: 7,
				output_tokens: 3,
				thinking_tokens: 0,
				cache_read_tokens: 0,
				total_tokens: 10,
			},
		},
	});
};

// Turns are strictly sequential in the real CLI — stdin lines queue and a second prompt does not
// preempt a running one — so this replays them one at a time behind a single promise chain.
let pending = Promise.resolve();
let buffer = "";

process.stdin.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (line.trim().length === 0) continue;
		let read;
		try {
			read = JSON.parse(line);
		} catch {
			// The real binary treats a malformed `user` message as fatal to the run.
			process.stderr.write(`fatal: unreadable stream input message\n`);
			process.exit(2);
		}
		if (read.event !== "user") {
			process.stderr.write(
				`warning: ignoring unsupported stream input message event ${JSON.stringify(read.event)}\n`,
			);
			continue;
		}
		const content =
			typeof read.message?.content === "string"
				? read.message.content
				: (read.message?.content ?? []).map((part) => part.text ?? "").join("");
		pending = pending.then(() => runTurn(content));
	}
});

process.stdin.on("end", () => {
	pending.then(() => process.exit(0));
});
