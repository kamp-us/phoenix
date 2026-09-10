import {describe, expect, it} from "vitest";
import {droppedEntries, emitFromFields, parseFields, read} from "./deviations.ts";

const ENTRY =
	"- **Scope narrowing** — **Said:** four gates. **Did:** three plus a bounce. **Why:** the fourth emits a trivial verdict. **Disposition:** stated here.";

describe("read", () => {
	it("is Absent only when nothing in the body reaches for the section", () => {
		expect(read("Fixes #1\n\n## Summary\n\nstuff")._tag).toBe("Absent");
	});

	it("is Malformed, never Absent, when a heading reaches for the section and misses", () => {
		expect(read("### Deviations\n\nNone.\n")._tag).toBe("Malformed");
		expect(read("## deviations\n\nNone.\n")._tag).toBe("Malformed");
	});

	it("carries `None.` as a Found claim of its own tag, never an empty entry list", () => {
		const result = read("## Deviations\n\nNone.\n");
		expect(result._tag === "Found" && result.value._tag).toBe("NoneDeclared");
	});

	it("carries all four fields of an entry", () => {
		const result = read(`## Deviations\n\n${ENTRY}\n`);
		if (result._tag !== "Found" || result.value._tag !== "Entries") {
			throw new Error(`expected Found/Entries, got ${result._tag}`);
		}
		expect(result.value.entries[0]).toEqual({
			label: "1",
			said: "four gates.",
			did: "three plus a bounce.",
			why: "the fourth emits a trivial verdict.",
			disposition: "stated here.",
		});
	});

	it("names the missing field rather than answering a bare Malformed", () => {
		const result = read("## Deviations\n\n- **Said:** a. **Did:** b. **Why:** c.\n");
		expect(result._tag === "Malformed" && result.reason).toContain("**Disposition:**");
	});

	it("refuses a section whose entries disclose nothing", () => {
		expect(read("## Deviations\n\nprobably nothing?\n")._tag).toBe("Malformed");
	});

	it("refuses two conforming headings — which one is the disclosure is undecidable", () => {
		const body = `## Deviations\n\nNone.\n\n## Deviations\n\n${ENTRY}\n`;
		expect(read(body)._tag).toBe("Malformed");
	});

	it("ignores a heading inside a fenced block", () => {
		expect(read("before\n\n```\n## Deviations\n\nNone.\n```\n\nafter")._tag).toBe("Absent");
	});
});

describe("parseFields", () => {
	it("takes the literal `None.` as the checked claim", () => {
		const parsed = parseFields("None.\n");
		expect(parsed._tag === "Fields" && parsed.disclosure._tag).toBe("NoneDeclared");
	});

	it("refuses a row short a column rather than composing a three-field entry", () => {
		expect(parseFields("4\ta\tb\tc\n")._tag).toBe("Unusable");
	});

	it("refuses a row whose field is blank", () => {
		expect(parseFields("4\ta\tb\tc\t \n")._tag).toBe("Unusable");
	});

	it("composes bytes its own reader accepts", () => {
		const composed = emitFromFields("-\ta.\tb.\tc.\td.\n");
		expect(composed._tag === "Composed" && read(composed.bytes)._tag).toBe("Found");
	});
});

describe("droppedEntries", () => {
	/** A section's bytes as a disclosure — the fixtures read through the format that owns them. */
	const disclose = (body: string) => {
		const result = read(body);
		if (result._tag !== "Found") throw new Error(`fixture is not readable: ${result._tag}`);
		return result.value;
	};

	const OTHER =
		"- **Out-of-scope change** — **Said:** the ledger row only. **Did:** the header too. **Why:** one helper writes both. **Disposition:** stated here.";

	it("names a standing entry the replacement leaves out", () => {
		const dropped = droppedEntries(
			disclose(`## Deviations\n\n${ENTRY}\n${OTHER}\n`),
			disclose(`## Deviations\n\n${OTHER}\n`),
		);
		expect(dropped.map((entry) => entry.said)).toEqual(["four gates."]);
	});

	it("takes an entry as carried when only its later fields changed", () => {
		const revised = ENTRY.replace("**Disposition:** stated here.", "**Disposition:** reverted.");
		expect(
			droppedEntries(
				disclose(`## Deviations\n\n${ENTRY}\n`),
				disclose(`## Deviations\n\n${revised}\n`),
			),
		).toEqual([]);
	});

	it("reads a replacement of `None.` over standing entries as dropping all of them", () => {
		const dropped = droppedEntries(
			disclose(`## Deviations\n\n${ENTRY}\n${OTHER}\n`),
			disclose("## Deviations\n\nNone.\n"),
		);
		expect(dropped).toHaveLength(2);
	});

	it("owes nothing when the standing disclosure declared none", () => {
		expect(
			droppedEntries(disclose("## Deviations\n\nNone.\n"), disclose(`## Deviations\n\n${ENTRY}\n`)),
		).toEqual([]);
	});
});
