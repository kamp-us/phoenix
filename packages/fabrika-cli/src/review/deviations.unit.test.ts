import {describe, expect, it} from "vitest";
import {readDeviations} from "./deviations.ts";

const ENTRY =
	"- **Scope narrowing** — **Said:** the AC asks for four gates. **Did:** three plus a bounce. **Why:** the fourth emits a trivial verdict. **Disposition:** stated in the PR body.";

describe("readDeviations", () => {
	it("reads absent when the body carries no `## Deviations` heading at all", () => {
		expect(readDeviations("Fixes #1\n\n## Summary\n\nstuff")).toEqual({
			state: "absent",
			entries: [],
		});
	});

	it("reads none-declared for the literal `None.`, which is a CHECKED claim", () => {
		expect(readDeviations("## Deviations\n\nNone.\n")).toEqual({
			state: "none-declared",
			entries: [],
		});
	});

	it("never folds absent into none-declared — the two are different facts", () => {
		expect(readDeviations("no heading here").state).not.toBe(
			readDeviations("## Deviations\n\nNone.").state,
		);
	});

	it("reads an entry's class label and the first line of its Said", () => {
		expect(readDeviations(`## Deviations\n\n${ENTRY}\n`)).toEqual({
			state: "found",
			entries: [{label: "1", said: "the AC asks for four gates."}],
		});
	});

	it("prints `-` for an entry whose label this reader does not recognise", () => {
		const body = "## Deviations\n\n- **Something else** — **Said:** a thing. **Did:** another.";
		expect(readDeviations(body).entries[0]?.label).toBeNull();
	});

	it("accepts a bare numeric label too — the label is a routing hint, not the disclosure", () => {
		const body = "## Deviations\n\n- **6** — **Said:** the fixture asserted the defect.";
		expect(readDeviations(body).entries[0]?.label).toBe("6");
	});

	it("joins an entry's continuation lines, so one wrapped entry is one entry", () => {
		const body = `## Deviations\n\n- **Declined guidance**\n  **Said:** take the reviewer's shape.\n  **Did:** kept mine.\n`;
		const result = readDeviations(body);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]).toEqual({label: "4", said: "take the reviewer's shape."});
	});

	it("reads a heading whose section fits neither shape as malformed", () => {
		expect(readDeviations("## Deviations\n\nprobably nothing?\n").state).toBe("malformed");
		expect(readDeviations("## Deviations\n\n").state).toBe("malformed");
	});

	it("stops at the next heading, so a later section is not read as an entry", () => {
		const body = `## Deviations\n\nNone.\n\n## Notes\n\n- **Said:** unrelated bullet.`;
		expect(readDeviations(body).state).toBe("none-declared");
	});

	it("ignores a `## Deviations` heading inside a fenced block", () => {
		const body = "before\n\n```\n## Deviations\n\nNone.\n```\n\nafter";
		expect(readDeviations(body).state).toBe("absent");
	});
});
