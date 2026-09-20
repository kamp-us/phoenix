import {expect, it} from "vitest";
import {registry, snapshot} from "../../commands/parse/fixtures.ts";
import {CallId, WindowId} from "../../protocol/ids.ts";
import {readCommandLine} from "./line.ts";

const options = {registry, snapshot, id: CallId.make("call"), window: WindowId.make("focused")};

it("keeps shell errors and precedence when registered commands are available", () => {
	for (const line of ["open", "window:close extra", "workspace:activate", "open counter"]) {
		expect(readCommandLine(line, options)).toEqual(readCommandLine(line));
	}
});

it("turns a non-shell registered path into a protocol call with the focused window", () => {
	const answer = readCommandLine("window close", options);
	expect(answer).toMatchObject({
		_tag: "Spell",
		call: {path: ["window", "close"], args: {}, window: "focused", id: "call", type: "spell.call"},
	});
});

it("offers a nearby registered path for an unknown command", () => {
	const answer = readCommandLine("windwo close", options);
	expect(answer).toMatchObject({
		_tag: "Refused",
		refusal: {_tag: "SpellParseRefused", didYouMean: "window"},
	});
});
