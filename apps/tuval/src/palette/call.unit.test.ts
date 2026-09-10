/** The two translations between a read line and the wire. */

import {describe, expect, it} from "vitest";
import {parse} from "../commands/parse/parse.ts";
import {WindowId} from "../protocol/ids.ts";
import {PROTOCOL_VERSION} from "../protocol/messages.ts";
import {failureLine, spellCallFor} from "./call.ts";
import {registry, snapshot} from "./fixtures.ts";

const draft = (line: string) => {
	const read = parse(line, registry, snapshot);
	if (read._tag !== "Complete") throw new Error(`the fixture line did not parse: ${line}`);
	return read.call;
};

describe("spellCallFor", () => {
	it("carries the read path, the decoded arguments and the opener's window", () => {
		const call = spellCallFor(draft("workspace new scratch"), WindowId.make("w-left"), () => "c-1");
		expect(call.type).toBe("spell.call");
		expect(call.version).toBe(PROTOCOL_VERSION);
		expect(call.id).toBe("c-1");
		expect(call.path).toEqual(["workspace", "new"]);
		expect(call.args).toEqual({name: "scratch"});
		expect(call.window).toBe("w-left");
	});

	it("omits the window when the palette was opened outside one", () => {
		const call = spellCallFor(draft("window close"), undefined, () => "c-2");
		expect(call.window).toBeUndefined();
		expect("window" in call).toBe(false);
	});
});

describe("failureLine", () => {
	it("shows the kernel's own message", () => {
		expect(failureLine({tag: "tuval/NameTaken", message: 'name "scratch" already exists'})).toBe(
			'name "scratch" already exists',
		);
	});

	it("names the spell and the expectation when the failure carries them", () => {
		expect(
			failureLine({
				tag: "tuval/BadArgs",
				message: "the direction is not one this desk knows",
				path: ["window", "move"],
				expected: "left|right|up|down",
			}),
		).toBe("window move: the direction is not one this desk knows (expected left|right|up|down)");
	});

	it("passes the kernel's suggestion through", () => {
		expect(
			failureLine({
				tag: "tuval/UnknownSpell",
				message: 'no spell is registered at "window splt"',
				didYouMean: "window split",
			}),
		).toBe('no spell is registered at "window splt" — did you mean window split?');
	});
});
