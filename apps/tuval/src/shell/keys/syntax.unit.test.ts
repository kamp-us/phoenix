/**
 * The Runekeeper cases, re-typed by hand from `monorepo/packages/runekeeper/syntax-vim.test.ts`.
 * `value` reads either side of the `Result` so a case reads as it did there; the error objects
 * carry `_tag` where Runekeeper carried `name`.
 */

import {Result} from "effect";
import {describe, expect, it} from "vitest";
import {normalize, parse, parseSequence, stringify} from "./syntax.ts";

const value = <A, E>(result: Result.Result<A, E>): A | E => Result.merge(result);

describe("stringify()", () => {
	describe("simple", () => {
		it("handles letters", () => {
			expect(stringify({key: "a"})).toBe("a");
			expect(stringify({key: "a", shiftKey: true})).toBe("a");
		});

		it("handles capital letters", () => {
			expect(stringify({key: "A"})).toBe("A");
			expect(stringify({key: "A", shiftKey: true})).toBe("A");
		});

		it("handles symbols", () => {
			expect(stringify({key: "/"})).toBe("/");
			expect(stringify({key: "/", shiftKey: true})).toBe("/");
		});

		it("handles numbers", () => {
			expect(stringify({key: "1"})).toBe("1");
			expect(stringify({key: "1", shiftKey: true})).toBe("1");
		});

		it("handles special keys", () => {
			expect(stringify({key: "Enter"})).toBe("<enter>");
			expect(stringify({key: "Enter", shiftKey: true})).toBe("<s-enter>");
		});

		it("handles aliases", () => {
			expect(stringify({key: "left"})).toBe("<arrowleft>");
			expect(stringify({key: "cr", shiftKey: true})).toBe("<s-enter>");
			expect(stringify({key: "esc"})).toBe("<escape>");
		});
	});

	it("falls back to event.code", () => {
		expect(stringify({key: "Unidentified", code: "Tab", shiftKey: true})).toBe("<s-tab>");
	});

	describe("modifiers", () => {
		it("handles letters with modifiers", () => {
			expect(stringify({key: "a", ctrlKey: true})).toBe("<c-a>");
			expect(stringify({key: "a", shiftKey: true, ctrlKey: true})).toBe("<c-a>");
		});

		it("handles capital letters with modifiers", () => {
			expect(stringify({key: "A", ctrlKey: true})).toBe("<c-A>");
			expect(stringify({key: "A", shiftKey: true, ctrlKey: true})).toBe("<c-A>");
		});

		it("handles symbols with modifiers", () => {
			expect(stringify({key: "/", ctrlKey: true})).toBe("<c-/>");
			expect(stringify({key: "/", shiftKey: true, ctrlKey: true})).toBe("<c-/>");
			expect(stringify({key: "-", ctrlKey: true})).toBe("<c-->");
		});

		it("handles numbers with modifiers", () => {
			expect(stringify({key: "1", ctrlKey: true})).toBe("<c-1>");
			expect(stringify({key: "1", shiftKey: true, ctrlKey: true})).toBe("<c-1>");
		});

		it("handles special keys with modifiers", () => {
			expect(stringify({key: "Enter", ctrlKey: true})).toBe("<c-enter>");
			expect(stringify({key: "Enter", shiftKey: true, ctrlKey: true})).toBe("<c-s-enter>");
		});

		it("handles multiple modifiers in alphabetical order", () => {
			expect(
				stringify({key: "a", shiftKey: true, ctrlKey: true, metaKey: true, altKey: true}),
			).toBe("<a-c-m-a>");
			expect(
				stringify({key: "Enter", shiftKey: true, ctrlKey: true, metaKey: true, altKey: true}),
				// Runekeeper's own case asserts `<c-m-s-enter>`, which its `stringify` cannot
				// produce: `altKey` always emits `a-`. The implementation is the contract, so the
				// re-typed case takes the value the algorithm returns.
			).toBe("<a-c-m-s-enter>");
		});
	});

	describe("special cases", () => {
		it("handles space", () => {
			expect(stringify({key: " "})).toBe("<space>");
			expect(stringify({key: " ", shiftKey: true})).toBe("<s-space>");
			expect(stringify({key: " ", shiftKey: true, ctrlKey: true})).toBe("<c-s-space>");
		});

		it("handles < and >", () => {
			expect(stringify({key: "<"})).toBe("<lt>");
			expect(stringify({key: "<", shiftKey: true})).toBe("<lt>");
			expect(stringify({key: "<", shiftKey: true, ctrlKey: true})).toBe("<c-lt>");
			expect(stringify({key: ">"})).toBe("<gt>");
			expect(stringify({key: ">", shiftKey: true})).toBe("<gt>");
			expect(stringify({key: ">", shiftKey: true, ctrlKey: true})).toBe("<c-gt>");
		});

		it("ensures Array#join safety", () => {
			expect(`${stringify({key: "<"})}${stringify({key: "a"})}${stringify({key: ">"})}`).toBe(
				"<lt>a<gt>",
			);
		});
	});

	describe("invalid keys", () => {
		it("handles unrecognized keys", () => {
			expect(stringify({key: "Unidentified"})).toBe("");
			expect(stringify({key: "Process"})).toBe("");
			expect(stringify({key: "Dead"})).toBe("");
		});

		it("handles modifier keys", () => {
			const modifiers = [
				"Alt",
				"Control",
				"Meta",
				"Shift",
				"OS",
				"Hyper",
				"Super",
				"OSLeft",
				"ControlRight",
			];
			for (const modifier of modifiers) {
				expect(stringify({key: modifier})).toBe("");
			}
		});
	});
});

describe("normalize()", () => {
	it("handles single characters", () => {
		expect(value(normalize("a"))).toBe("a");
		expect(value(normalize("A"))).toBe("A");
		expect(value(normalize("/"))).toBe("/");
		expect(value(normalize("1"))).toBe("1");
	});

	it("handles keys", () => {
		expect(value(normalize("<a>"))).toBe("a");
		expect(value(normalize("<A>"))).toBe("A");
		expect(value(normalize("</>"))).toBe("/");
		expect(value(normalize("<1>"))).toBe("1");

		expect(value(normalize("<c-a>"))).toBe("<c-a>");
		expect(value(normalize("<c-A>"))).toBe("<c-A>");
		expect(value(normalize("<c-/>"))).toBe("<c-/>");
		expect(value(normalize("<c-1>"))).toBe("<c-1>");

		expect(value(normalize("<Escape>"))).toBe("<escape>");
		expect(value(normalize("<C-ESC>"))).toBe("<c-escape>");
		expect(value(normalize("<F12>"))).toBe("<f12>");
	});

	it("handles < and >", () => {
		expect(value(normalize("<"))).toBe("<lt>");
		expect(value(normalize(">"))).toBe("<gt>");
	});

	it("handles the empty string", () => {
		expect(value(normalize(""))).toEqual({
			_tag: "InvalidKeyError",
			key: "",
			message: "Invalid key: ",
		});
	});

	it("refuses a bare modifier, which parses cleanly and spells nothing", () => {
		// These reach `ignored` in `stringify`, which answers "". Succeeding with that empty spelling
		// let a config store it as the prefix and left the shell permanently unarmable (#7499).
		expect([
			value(normalize("<Shift>")),
			value(normalize("<Control>")),
			value(normalize("<Alt>")),
			value(normalize("<Meta>")),
			value(normalize("<Unidentified>")),
		]).toEqual([
			{_tag: "InvalidKeyError", key: "<Shift>", message: "Invalid key: <Shift>"},
			{_tag: "InvalidKeyError", key: "<Control>", message: "Invalid key: <Control>"},
			{_tag: "InvalidKeyError", key: "<Alt>", message: "Invalid key: <Alt>"},
			{_tag: "InvalidKeyError", key: "<Meta>", message: "Invalid key: <Meta>"},
			{
				_tag: "InvalidKeyError",
				key: "<Unidentified>",
				message: "Invalid key: <Unidentified>",
			},
		]);
	});

	it("handles errors", () => {
		expect(value(normalize("ab"))).toEqual({
			_tag: "InvalidKeyError",
			key: "ab",
			message: "Invalid key: ab",
		});
		expect(value(normalize("<S-gt>"))).toEqual({
			_tag: "DisallowedModifierError",
			modifier: "S",
			context: "<S-gt>",
			message: "<S-gt>: Unusable modifier with single-character keys: S",
		});
	});

	it("round-trips every spelling the default table uses", () => {
		for (const key of ["|", "-", "h", "j", "k", "l", "x", "N", ":", "r", "<c-b>", "<c-h>"]) {
			expect(value(normalize(key))).toBe(key);
		}
	});
});

describe("parseSequence()", () => {
	it("handles single characters", () => {
		expect(parseSequence("a")).toEqual(["a"]);
		expect(parseSequence("<")).toEqual(["<"]);
		expect(parseSequence(">")).toEqual([">"]);
		expect(parseSequence("/")).toEqual(["/"]);
		expect(parseSequence("1")).toEqual(["1"]);
		expect(parseSequence(" ")).toEqual([" "]);
		expect(parseSequence("\t")).toEqual(["\t"]);
		expect(parseSequence("\n")).toEqual(["\n"]);
	});

	it("handles sequence of characters", () => {
		expect(parseSequence("a<>/1 \t\n")).toEqual(["a", "<", ">", "/", "1", " ", "\t", "\n"]);
		expect(parseSequence(">>")).toEqual([">", ">"]);
		expect(parseSequence("<2j")).toEqual(["<", "2", "j"]);
	});

	it("handles single keys", () => {
		expect(parseSequence("<a>")).toEqual(["<a>"]);
		expect(parseSequence("<A>")).toEqual(["<A>"]);
		expect(parseSequence("</>")).toEqual(["</>"]);
		expect(parseSequence("<1>")).toEqual(["<1>"]);
		expect(parseSequence("<Escape>")).toEqual(["<Escape>"]);
		expect(parseSequence("<escApe>")).toEqual(["<escApe>"]);

		expect(parseSequence("<c-a>")).toEqual(["<c-a>"]);
		expect(parseSequence("<c-A>")).toEqual(["<c-A>"]);
		expect(parseSequence("<c-/>")).toEqual(["<c-/>"]);
		expect(parseSequence("<c-1>")).toEqual(["<c-1>"]);
		expect(parseSequence("<c-Escape>")).toEqual(["<c-Escape>"]);
		expect(parseSequence("<c-a-m-Escape>")).toEqual(["<c-a-m-Escape>"]);
		expect(parseSequence("<s-K1>")).toEqual(["<s-K1>"]);
	});

	it("handles invalid single keys", () => {
		expect(parseSequence("<-a>")).toEqual(["<-a>"]);
		expect(parseSequence("<x-esc>")).toEqual(["<x-esc>"]);
		expect(parseSequence("<shift-esc>")).toEqual(["<shift-esc>"]);
		expect(parseSequence("<s-++>")).toEqual(["<s-++>"]);
	});

	it("handles mix of characters and keys", () => {
		expect(parseSequence("a<a><c-a><esc><c-esc>b<Del>")).toEqual([
			"a",
			"<a>",
			"<c-a>",
			"<esc>",
			"<c-esc>",
			"b",
			"<Del>",
		]);

		expect(parseSequence("<c-<>")).toEqual(["<", "c", "-", "<", ">"]);
		expect(parseSequence("<c->>")).toEqual(["<c->", ">"]);
		expect(parseSequence("<c- >")).toEqual(["<", "c", "-", " ", ">"]);
	});

	it("handles empty string", () => {
		expect(parseSequence("")).toEqual([""]);
	});
});

describe("parse()", () => {
	it("handles single characters", () => {
		expect(value(parse("a"))).toEqual({key: "a"});
		expect(value(parse("A"))).toEqual({key: "A"});
		expect(value(parse("/"))).toEqual({key: "/"});
		expect(value(parse("<"))).toEqual({key: "<"});
		expect(value(parse(">"))).toEqual({key: ">"});
		expect(value(parse("1"))).toEqual({key: "1"});
	});

	describe("keys", () => {
		it("handles dash", () => {
			expect(value(parse("<->"))).toEqual({key: "-"});
			expect(value(parse("<a-->"))).toEqual({key: "-", altKey: true});
		});

		it("handles < and >", () => {
			expect(value(parse("<gt>"))).toEqual({key: ">"});
			expect(value(parse("<less>"))).toEqual({key: "<"});
			expect(value(parse("<c-lesser>"))).toEqual({key: "<", ctrlKey: true});
		});

		it("preserves case", () => {
			expect(value(parse("<escape>"))).toEqual({key: "escape"});
			expect(value(parse("<Escape>"))).toEqual({key: "Escape"});
			expect(value(parse("<escApe>"))).toEqual({key: "escApe"});
			expect(value(parse("<f1>"))).toEqual({key: "f1"});
			expect(value(parse("<F1>"))).toEqual({key: "F1"});
			expect(value(parse("<A>"))).toEqual({key: "A"});
		});

		it("handles modifiers", () => {
			expect(value(parse("<c-s-a-m-escape>"))).toEqual({
				key: "escape",
				altKey: true,
				ctrlKey: true,
				metaKey: true,
				shiftKey: true,
			});

			expect(value(parse("<c-1>"))).toEqual({key: "1", ctrlKey: true});
		});

		it("handles aliases", () => {
			expect(value(parse("<left>"))).toEqual({key: "ArrowLeft"});
			expect(value(parse("<c-cr>"))).toEqual({key: "Enter", ctrlKey: true});
		});
	});

	it("handles the empty string", () => {
		expect(value(parse(""))).toEqual({
			_tag: "InvalidKeyError",
			key: "",
			message: "Invalid key: ",
		});
	});

	describe("errors", () => {
		it("handles invalid single characters", () => {
			expect(value(parse(" "))).toEqual({
				_tag: "InvalidKeyError",
				key: " ",
				message: "Invalid key:  ",
			});
			expect(value(parse("\t"))).toEqual({
				_tag: "InvalidKeyError",
				key: "\t",
				message: "Invalid key: \t",
			});
			expect(value(parse("\n"))).toEqual({
				_tag: "InvalidKeyError",
				key: "\n",
				message: "Invalid key: \n",
			});
		});

		it("handles invalid keys", () => {
			expect(value(parse("<>"))).toEqual({
				_tag: "InvalidKeyError",
				key: "<>",
				message: "Invalid key: <>",
			});
			expect(value(parse("<ctrl-a>"))).toEqual({
				_tag: "InvalidKeyError",
				key: "<ctrl-a>",
				message: "Invalid key: <ctrl-a>",
			});
			expect(value(parse("ab"))).toEqual({
				_tag: "InvalidKeyError",
				key: "ab",
				message: "Invalid key: ab",
			});
			expect(value(parse("<a"))).toEqual({
				_tag: "InvalidKeyError",
				key: "<a",
				message: "Invalid key: <a",
			});
			expect(value(parse("<a >"))).toEqual({
				_tag: "InvalidKeyError",
				key: "<a >",
				message: "Invalid key: <a >",
			});
			expect(value(parse("<a- >"))).toEqual({
				_tag: "InvalidKeyError",
				key: "<a- >",
				message: "Invalid key: <a- >",
			});
			expect(value(parse("<a-++>"))).toEqual({
				_tag: "InvalidKeyError",
				key: "<a-++>",
				message: "Invalid key: <a-++>",
			});
		});

		it("handles unknown modifiers", () => {
			expect(value(parse("<x-a>"))).toEqual({
				_tag: "UnknownModifierError",
				modifier: "x",
				context: "<x-a>",
				message: "<x-a>: Unknown modifier: x",
			});
			expect(value(parse("<X-a>"))).toEqual({
				_tag: "UnknownModifierError",
				modifier: "X",
				context: "<X-a>",
				message: "<X-a>: Unknown modifier: X",
			});
			expect(value(parse("<c-c-a>"))).toEqual({
				_tag: "DuplicateModifierError",
				modifier: "c",
				context: "<c-c-a>",
				message: "<c-c-a>: Duplicate modifier: c",
			});
			expect(value(parse("<c-C-a>"))).toEqual({
				_tag: "DuplicateModifierError",
				modifier: "C",
				context: "<c-C-a>",
				message: "<c-C-a>: Duplicate modifier: C",
			});
			expect(value(parse("<C-c-a>"))).toEqual({
				_tag: "DuplicateModifierError",
				modifier: "c",
				context: "<C-c-a>",
				message: "<C-c-a>: Duplicate modifier: c",
			});
			expect(value(parse("<a-s-C-m-s-esc>"))).toEqual({
				_tag: "DuplicateModifierError",
				modifier: "s",
				context: "<a-s-C-m-s-esc>",
				message: "<a-s-C-m-s-esc>: Duplicate modifier: s",
			});
			expect(value(parse("<a-s-C-m-S-esc>"))).toEqual({
				_tag: "DuplicateModifierError",
				modifier: "S",
				context: "<a-s-C-m-S-esc>",
				message: "<a-s-C-m-S-esc>: Duplicate modifier: S",
			});
		});

		it("handles disallowed modifiers", () => {
			expect(value(parse("<s-a>"))).toEqual({
				_tag: "DisallowedModifierError",
				modifier: "s",
				context: "<s-a>",
				message: "<s-a>: Unusable modifier with single-character keys: s",
			});
			expect(value(parse("<c-S-/>"))).toEqual({
				_tag: "DisallowedModifierError",
				modifier: "S",
				context: "<c-S-/>",
				message: "<c-S-/>: Unusable modifier with single-character keys: S",
			});
			expect(value(parse("<s-lt>"))).toEqual({
				_tag: "DisallowedModifierError",
				modifier: "s",
				context: "<s-lt>",
				message: "<s-lt>: Unusable modifier with single-character keys: s",
			});
			expect(value(parse("<S-greater>"))).toEqual({
				_tag: "DisallowedModifierError",
				modifier: "S",
				context: "<S-greater>",
				message: "<S-greater>: Unusable modifier with single-character keys: S",
			});
		});
	});
});
