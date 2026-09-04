import {describe, expect, it} from "vitest";
import {complete} from "./complete.ts";
import {didYouMean} from "./did-you-mean.ts";
import {registry, snapshot} from "./fixtures.ts";
import {parse} from "./parse.ts";
import {buildSpellIndex} from "./spell-index.ts";

const run = (input: string) => parse(input, registry, snapshot);

describe("parse", () => {
	it("completes a spell that takes no arguments", () => {
		expect(run("window close")).toEqual({
			_tag: "Complete",
			call: {path: ["window", "close"], args: {}},
		});
	});

	it("binds a positional argument to the first parameter", () => {
		expect(run("workspace activate ws-2")).toEqual({
			_tag: "Complete",
			call: {path: ["workspace", "activate"], args: {workspace: "ws-2"}},
		});
	});

	it("binds by name when a token names one of the parameters", () => {
		expect(run("workspace rename name=demo ws-2")).toEqual({
			_tag: "Complete",
			call: {path: ["workspace", "rename"], args: {name: "demo", workspace: "ws-2"}},
		});
	});

	it("is partial while a required argument is still owed", () => {
		const result = run("workspace activate");
		expect(result._tag).toBe("Partial");
		expect(result._tag === "Partial" && result.cursorArg?.name).toBe("workspace");
		expect(result._tag === "Partial" && result.spell?.path).toEqual(["workspace", "activate"]);
	});

	it("refuses a wrong argument at the token's position, naming the expectation", () => {
		expect(run("window move diagonal")).toEqual({
			_tag: "Refused",
			position: 12,
			expected: "left|right|up|down",
		});
	});

	it("refuses a mistyped path with a suggestion", () => {
		expect(run("windwo close")).toEqual({
			_tag: "Refused",
			position: 0,
			expected: "window|workspace|process|wizard-inspect",
			didYouMean: "window",
		});
	});

	it("refuses a token past the last parameter", () => {
		const result = run("window close extra");
		expect(result).toEqual({_tag: "Refused", position: 13, expected: "no further arguments"});
	});

	it("keeps a quoted argument whole", () => {
		expect(run('workspace rename ws-2 "my space"')).toEqual({
			_tag: "Complete",
			call: {path: ["workspace", "rename"], args: {workspace: "ws-2", name: "my space"}},
		});
	});

	it("reads a half-typed deeper segment as a path, not as a bad argument", () => {
		// A spell registered at a prefix of a longer path is the shape that gets this wrong: `focus
		// layout c` would bind `c` as an argument to `focus layout` and refuse it.
		const shadowed = buildSpellIndex([
			{
				path: ["focus", "layout"],
				describe: "Show the layout.",
				params: undefined,
				capabilities: [],
			},
			{
				path: ["focus", "layout", "close"],
				describe: "Close the layout view.",
				params: undefined,
				capabilities: [],
			},
		]);
		expect(parse("focus layout c", shadowed, snapshot)._tag).toBe("Partial");
		expect(complete("focus layout c", shadowed, snapshot).map((c) => c.value)).toEqual(["close"]);
		expect(parse("focus layout", shadowed, snapshot)).toEqual({
			_tag: "Complete",
			call: {path: ["focus", "layout"], args: {}},
		});
	});

	it("never throws on an input the grammar has no place for", () => {
		for (const input of ["", "   ", '"', "\\", "=", "===", "a=b=c", '"unclosed', "window move ="]) {
			expect(() => run(input)).not.toThrow();
		}
	});
});

describe("didYouMean", () => {
	it("offers the closest choice within the bound", () => {
		expect(didYouMean("windwo", ["window", "workspace"])).toBe("window");
		expect(didYouMean("clse", ["close", "move"])).toBe("close");
	});

	it("offers nothing when every choice is further than the bound", () => {
		expect(didYouMean("diagonal", ["left", "right", "up", "down"])).toBeUndefined();
		expect(didYouMean("abc", ["xyz"])).toBeUndefined();
	});

	it("breaks a tie on the earlier choice, so one input has one answer", () => {
		expect(didYouMean("clse", ["close", "clase"])).toBe("close");
		expect(didYouMean("clse", ["clase", "close"])).toBe("clase");
	});
});
