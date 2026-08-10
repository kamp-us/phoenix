import {describe, expect, it} from "vitest";
import {parseAsserted} from "./asserted.ts";
import {ASSERTED} from "./fixtures.test-support.ts";

describe("parseAsserted", () => {
	it("reads the four sections a caller wrote", () => {
		const parsed = parseAsserted(ASSERTED);
		expect(parsed._tag).toBe("Asserted");
		if (parsed._tag !== "Asserted") return;
		expect(parsed.value.intent).toBe("Widen the fanout guard.");
		expect(parsed.value.unsure).toBe("Whether one level is enough.");
	});

	it("refuses an empty Unsure — a successor reads an empty Unsure as certainty", () => {
		const parsed = parseAsserted(ASSERTED.replace("Whether one level is enough.", ""));
		expect(parsed).toMatchObject({problem: {_tag: "Empty", heading: "## Unsure"}});
	});

	it("refuses a section out of order", () => {
		const swapped = [
			"## Established",
			"two",
			"## Intent",
			"one",
			"## Next act",
			"three",
			"## Unsure",
			"four",
		].join("\n");
		expect(parseAsserted(swapped)).toMatchObject({problem: {_tag: "Shape"}});
	});

	it("refuses a fifth heading and prose before the first — the section set is closed", () => {
		expect(parseAsserted(`${ASSERTED}\n## Note\nAlso do this.\n`)).toMatchObject({
			problem: {_tag: "Outside"},
		});
		expect(parseAsserted(`Read this first.\n${ASSERTED}`)).toMatchObject({
			problem: {_tag: "Outside"},
		});
	});

	it("refuses bytes carrying no section at all rather than answering an empty half", () => {
		expect(parseAsserted("just some prose")).toMatchObject({problem: {_tag: "Outside"}});
		expect(parseAsserted("")).toMatchObject({problem: {_tag: "Shape"}});
	});
});
