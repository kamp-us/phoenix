import {describe, expect, it} from "vitest";
import {capClearAuthorsKey} from "./cap-clear-authors.ts";

const pattern = new RegExp(capClearAuthorsKey.jsonSchema?.items?.pattern ?? "(?!)");

const accepted = (entry: string): boolean => capClearAuthorsKey.decode([entry])._tag === "Value";

describe("the entry pattern an editor reds on says what the decoder says", () => {
	const entries = [
		"@usirin",
		"@notusirin",
		"@a",
		"@kamp-us/founders",
		"@kamp-us",
		"usirin",
		"@",
		"@-usirin",
		"@usirin-",
		"@two words",
		"@a/b/c",
	];

	for (const entry of entries) {
		it(`agrees on ${JSON.stringify(entry)}`, () => {
			expect(pattern.test(entry)).toBe(accepted(entry));
		});
	}
});
