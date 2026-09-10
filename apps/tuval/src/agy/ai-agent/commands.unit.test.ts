/**
 * `/help`'s catalog, read out of the flat `--output-format=json` envelope.
 *
 * The fixture is one live v1.1.27 invocation, verbatim, because this envelope is a *different*
 * shape from the streaming one `wire.ts` reads and a hand-written approximation of it would pass a
 * test the real CLI fails — which is the exact defect #8203 caught in the streaming reader.
 */

import {describe, expect, it} from "vitest";
import {commandsOf} from "./commands.ts";

/** Captured verbatim from `agy --print='/help' --output-format=json`, trimmed to four rows. */
const help = JSON.stringify({
	conversation_id: "",
	status: "SUCCESS",
	response: "/agents\tList available custom agents\n",
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
				{name: "agents", description: "List available custom agents"},
				{name: "config", aliases: ["settings"], description: "Open settings panel"},
				{name: "effort", description: "Set the reasoning effort"},
				{name: "help"},
			],
		},
	},
});

describe("the /help catalog", () => {
	it("reads the rows out of command.data.commands", () => {
		expect(commandsOf(help)).toEqual([
			{name: "agents", description: "List available custom agents"},
			{name: "config", description: "Open settings panel"},
			{name: "settings", description: "Open settings panel"},
			{name: "effort", description: "Set the reasoning effort"},
			{name: "help"},
		]);
	});

	it("carries no leading slash, because the composer writes the sigil itself", () => {
		expect(commandsOf(help).filter((row) => row.name.startsWith("/"))).toEqual([]);
	});

	it("answers empty rather than throwing on output it cannot read", () => {
		expect([
			commandsOf(""),
			commandsOf("not json at all"),
			commandsOf("[]"),
			commandsOf(JSON.stringify({status: "SUCCESS"})),
			commandsOf(JSON.stringify({command: {name: "help", data: {commands: "nope"}}})),
			commandsOf(JSON.stringify({command: {name: "help", data: {commands: [{}, 3, null]}}})),
		]).toEqual([[], [], [], [], [], []]);
	});
});
