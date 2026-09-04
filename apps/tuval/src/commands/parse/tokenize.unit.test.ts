import {describe, expect, it} from "vitest";
import {tokenize} from "./tokenize.ts";

describe("tokenize", () => {
	it("splits on whitespace and carries each token's span", () => {
		expect(tokenize("window close")).toEqual({
			tokens: [
				{text: "window", start: 0, end: 6},
				{text: "close", start: 7, end: 12},
			],
			trailingSeparator: false,
			openQuote: false,
		});
	});

	it("groups a quoted run and reports the span including the quotes", () => {
		const {tokens} = tokenize('workspace rename "my space"');
		expect(tokens[2]).toEqual({text: "my space", start: 17, end: 27});
	});

	it("escapes the next character inside and outside quotes", () => {
		expect(tokenize("a\\ b").tokens).toEqual([{text: "a b", start: 0, end: 4}]);
		expect(tokenize('"a\\"b"').tokens).toEqual([{text: 'a"b', start: 0, end: 6}]);
	});

	it("reports a trailing separator, so the caret is on a fresh token", () => {
		expect(tokenize("window ").trailingSeparator).toBe(true);
		expect(tokenize("window").trailingSeparator).toBe(false);
		expect(tokenize("  ").trailingSeparator).toBe(true);
		expect(tokenize("").trailingSeparator).toBe(false);
	});

	it("does not read a space inside an open quote as a separator", () => {
		const result = tokenize('rename "my sp');
		expect(result.openQuote).toBe(true);
		expect(result.trailingSeparator).toBe(false);
		expect(result.tokens[1]?.text).toBe("my sp");
	});

	it("drops a trailing backslash rather than refusing the line", () => {
		expect(tokenize("ab\\").tokens).toEqual([{text: "ab", start: 0, end: 3}]);
	});
});
