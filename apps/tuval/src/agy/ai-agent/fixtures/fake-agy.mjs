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
 * - **`step_index` and `num_turns` are the conversation's, not the process's, and `result.usage` is
 *   the conversation's running total.** All three continue across a resume in the real binary
 *   (measured; ADR 0362), which is why they are carried in a sidecar beside `$AGY_FAKE_LOG` rather
 *   than in module state: a respawned child restarting its counters would alias the usage keys the
 *   ledger already holds, and a fake that did so would hide the defect #8695 was about.
 * - SIGINT emits a well-formed terminal `result` with `status: "ERROR"` and `error: "interrupted"`,
 *   then exits 1. There is no `INTERRUPTED` *status*, because the real binary never emits one either.
 * - **A reply streams as many `ACTIVE` `agent_response` deltas, not one.** The real binary emits one
 *   per ~25 ms for the length of the answer (measured at v1.2.1), and the difference is load-bearing
 *   for a stop: cut before the first delta the mapper has no `responseId` and mints the cut row under
 *   `<cid>:response`, cut after one it marks the streamed row under `<cid>:<step_index>`. Only the
 *   second is the shape a desk cut is, so `AGY_FAKE_STREAM_DELTAS` makes a turn stream that many
 *   deltas `AGY_FAKE_DELTA_MS` apart before its `DONE` — long enough for a test to press Escape
 *   mid-text. Unset, a turn is the single-delta one every case before #9194 drove.
 * - A prompt beginning `tools:` replays a captured **multi-call** planner step as the binary
 *   serialises one on the live wire: a `tool` step per call, each with its own `step_index` and its
 *   own `tool_info.output` (`CAPTURED_CALLS`).
 *
 * Every invocation appends its argv to `$AGY_FAKE_LOG` as one JSON line, which is how a test
 * asserts a composed argv against the thing that actually received it.
 */

import {appendFileSync, readFileSync, writeFileSync} from "node:fs";

const argv = process.argv.slice(2);

const log = process.env.AGY_FAKE_LOG;
if (log !== undefined) appendFileSync(log, `${JSON.stringify(argv)}\n`);

const pidLog = process.env.AGY_FAKE_PID_LOG;
if (pidLog !== undefined) appendFileSync(pidLog, `${process.pid}\n`);

// `AGY_FAKE_LINGER` makes this process outlive its own stdin, which is what lets a test tell a child
// that was *killed* from one that merely noticed the pipe close — the distinction #8696 turns on.
if (process.env.AGY_FAKE_LINGER === "1") setInterval(() => {}, 60_000);

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

/** How many `ACTIVE` deltas the reply streams before its `DONE`, and how far apart. */
const STREAM_DELTAS = Number(process.env.AGY_FAKE_STREAM_DELTAS ?? "0");
const DELTA_MS = Number(process.env.AGY_FAKE_DELTA_MS ?? "25");

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

/** Where this conversation's counters live between processes, so a resume continues them. */
const statePath = log === undefined ? undefined : `${log}.${conversationId}.state`;

const readState = () => {
	if (statePath === undefined) return {steps: 0, turns: 0, input: 0, output: 0};
	try {
		return JSON.parse(readFileSync(statePath, "utf8"));
	} catch {
		return {steps: 0, turns: 0, input: 0, output: 0};
	}
};

let state = readState();

const saveState = () => {
	if (statePath !== undefined) writeFileSync(statePath, JSON.stringify(state));
};

const cumulative = () => ({
	input_tokens: state.input,
	output_tokens: state.output,
	thinking_tokens: 0,
	cache_read_tokens: 0,
	total_tokens: state.input + state.output,
});

process.on("SIGINT", () => {
	state = {...state, turns: state.turns + 1};
	saveState();
	write({
		event: "result",
		result: {
			conversation_id: conversationId,
			status: "ERROR",
			response: "",
			error: "interrupted",
			num_turns: state.turns,
			usage: cumulative(),
		},
	});
	process.exit(1);
});

/**
 * The two calls of one multi-call planner step, as the real binary serialises them on the live wire:
 * **one `tool` step each, with its own `step_index` and its own `tool_info.output`** — measured at
 * v1.1.28 against the same turn `transcript-fixtures.ts`' capture comes from, where the *on-disk*
 * log instead puts both calls on one `PLANNER_RESPONSE` and pairs them with their outcomes by
 * `step_index` (`transcript.ts`). A fake that merged the two outputs into one step would hide #8689.
 */
const CAPTURED_CALLS = [
	{path: "/Users/founder/agyprobe/one.txt", output: "1: alpha\n2: beta\n3: gamma\n4: \n"},
	{
		path: "/Users/founder/agyprobe/two.txt",
		output: "1: bir\n2: iki\n3: uc\n4: dort\n5: bes\n6: \n",
	},
];

const runCall = async (index, call) => {
	const info = {name: "view_file", parameters: {AbsolutePath: call.path}};
	const step = {
		conversation_id: conversationId,
		step_index: index,
		step_type: "tool",
		tool_name: "view_file",
	};
	write({event: "step_update", step_update: {...step, state: "ACTIVE", tool_info: info}});
	await sleep(10);
	write({
		event: "step_update",
		step_update: {
			...step,
			state: "DONE",
			duration_seconds: 0.01,
			tool_info: {...info, output: call.output},
		},
	});
};

const runTurn = async (content) => {
	await sleep(TURN_DELAY_MS);
	// `tools:` asks for the captured multi-call step; anything else is the plain reply turn.
	if (content.startsWith("tools:")) return await runToolTurn();
	const index = state.steps;
	state = {...state, steps: index + 2};
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
	for (let delta = 0; delta < STREAM_DELTAS; delta += 1) {
		await sleep(DELTA_MS);
		write({
			event: "step_update",
			step_update: {
				conversation_id: conversationId,
				step_index: index + 1,
				state: "ACTIVE",
				step_type: "agent_response",
				text_delta: `chunk-${delta} `,
			},
		});
	}
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
	state = {...state, turns: state.turns + 1, input: state.input + 7, output: state.output + 3};
	saveState();
	write({
		event: "result",
		result: {
			conversation_id: conversationId,
			status: "SUCCESS",
			response: `you said ${content}`,
			num_turns: state.turns,
			usage: cumulative(),
		},
	});
};

const runToolTurn = async () => {
	const index = state.steps;
	state = {...state, steps: index + 4};
	write({
		event: "step_update",
		step_update: {
			conversation_id: conversationId,
			step_index: index,
			state: "DONE",
			step_type: "user_input",
		},
	});
	await runCall(index + 1, CAPTURED_CALLS[0]);
	await runCall(index + 2, CAPTURED_CALLS[1]);
	const reply = "one.txt: 4 lines, two.txt: 6 lines";
	write({
		event: "step_update",
		step_update: {
			conversation_id: conversationId,
			step_index: index + 3,
			state: "DONE",
			step_type: "agent_response",
			text_delta: reply,
			usage: {
				input_tokens: 7,
				output_tokens: 3,
				thinking_tokens: 0,
				cache_read_tokens: 0,
				total_tokens: 10,
			},
		},
	});
	state = {...state, turns: state.turns + 1, input: state.input + 7, output: state.output + 3};
	saveState();
	write({
		event: "result",
		result: {
			conversation_id: conversationId,
			status: "SUCCESS",
			response: reply,
			num_turns: state.turns,
			usage: cumulative(),
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
	if (process.env.AGY_FAKE_LINGER === "1") return;
	pending.then(() => process.exit(0));
});
