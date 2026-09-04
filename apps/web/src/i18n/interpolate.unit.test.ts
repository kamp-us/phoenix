import {describe, expect, it} from "vitest";
import {interpolate} from "./interpolate";

describe("interpolate", () => {
	it("substitutes a named placeholder", () => {
		expect(interpolate("merhaba {name}", {name: "Elif"})).toBe("merhaba Elif");
	});

	it("substitutes every occurrence and stringifies numbers", () => {
		expect(interpolate("{n} / {n} · {total}", {n: 2, total: 9})).toBe("2 / 2 · 9");
	});

	it("leaves an unsupplied placeholder verbatim, so the gap reads as a bug", () => {
		expect(interpolate("merhaba {name}", {other: "x"})).toBe("merhaba {name}");
	});

	it("returns the message untouched with no params", () => {
		expect(interpolate("içeriğe geç")).toBe("içeriğe geç");
	});

	it("does not resolve an inherited property as a param", () => {
		expect(interpolate("{toString}", {})).toBe("{toString}");
	});
});
