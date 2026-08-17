import {describe, expect, it} from "vitest";
import {bodyDefect} from "../build/pr-body.ts";
import {readDeviations} from "./deviations.ts";

const ENTRY =
	"- **Scope narrowing** — **Said:** the AC asks for four gates. **Did:** three plus a bounce. **Why:** the fourth emits a trivial verdict. **Disposition:** stated in the PR body.";

describe("readDeviations", () => {
	it("reads absent when the body carries no `## Deviations` heading at all", () => {
		const result = readDeviations("Fixes #1\n\n## Summary\n\nstuff");
		expect(result.state).toBe("absent");
		expect(result.entries).toEqual([]);
	});

	it("reads none-declared for the literal `None.`, which is a CHECKED claim", () => {
		expect(readDeviations("## Deviations\n\nNone.\n")).toEqual({
			state: "none-declared",
			entries: [],
			reason: null,
		});
	});

	it("never folds absent into none-declared — the two are different facts", () => {
		expect(readDeviations("no heading here").state).not.toBe(
			readDeviations("## Deviations\n\nNone.").state,
		);
	});

	it("reads an entry's class label and its Said", () => {
		expect(readDeviations(`## Deviations\n\n${ENTRY}\n`)).toEqual({
			state: "found",
			entries: [{label: "1", said: "the AC asks for four gates."}],
			reason: null,
		});
	});

	it("prints `-` for an entry whose label this reader does not recognise", () => {
		const body = `## Deviations\n\n- **Something else** — **Said:** a thing. **Did:** another. **Why:** a reason. **Disposition:** stated.`;
		expect(readDeviations(body).entries[0]?.label).toBeNull();
	});

	it("accepts a bare numeric label too — the label is a routing hint, not the disclosure", () => {
		const body = `## Deviations\n\n- **6** — **Said:** the fixture asserted the defect. **Did:** replaced it. **Why:** it asserted the bug. **Disposition:** stated.`;
		expect(readDeviations(body).entries[0]?.label).toBe("6");
	});

	it("joins an entry's continuation lines, so one wrapped entry is one entry", () => {
		const body = `## Deviations\n\n- **Declined guidance**\n  **Said:** take the reviewer's shape.\n  **Did:** kept mine.\n  **Why:** it reads the label.\n  **Disposition:** stated here.\n`;
		const result = readDeviations(body);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]).toEqual({label: "4", said: "take the reviewer's shape."});
	});

	it("carries a Said that wraps in full, collapsed to one line", () => {
		const body = `## Deviations\n\n- **Said:** the criterion asks for the whole clause,\n  including the half that wrapped.\n  **Did:** kept it. **Why:** #5572. **Disposition:** stated.\n`;
		expect(readDeviations(body).entries[0]?.said).toBe(
			"the criterion asks for the whole clause, including the half that wrapped.",
		);
	});

	it("reads a heading whose section fits neither shape as malformed", () => {
		expect(readDeviations("## Deviations\n\nprobably nothing?\n").state).toBe("malformed");
		expect(readDeviations("## Deviations\n\n").state).toBe("malformed");
	});

	it("names what drifted on malformed, so the author is told which field is missing", () => {
		const body = "## Deviations\n\n- **Said:** a. **Did:** b. **Why:** c.\n";
		const result = readDeviations(body);
		expect(result.state).toBe("malformed");
		expect(result.reason).toContain("**Disposition:**");
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

/**
 * The defect #5566 named: the producer accepted bodies the consumer failed closed on, and nothing
 * ran one body through both sides. These do, over the shapes each side used to answer differently.
 */
describe("what `build pr` accepts is never read as malformed", () => {
	const accepted = (body: string): boolean => bodyDefect(body, 4312, false) === null;

	const bodies: ReadonlyArray<readonly [string, string]> = [
		["a four-field entry", `Fixes #4312\n\ndid a thing.\n\n## Deviations\n\n${ENTRY}\n`],
		[
			"a wrapped four-field entry",
			`Fixes #4312\n\ndid a thing.\n\n## Deviations\n\n- **Out-of-scope change**\n  **Said:** one file.\n  **Did:** two.\n  **Why:** the second stated the same rule.\n  **Disposition:** stated here.\n`,
		],
		["the `None.` claim", "Fixes #4312\n\ndid a thing.\n\n## Deviations\n\nNone.\n"],
	];

	for (const [shape, body] of bodies) {
		it(`accepts ${shape}, and the review reader agrees`, () => {
			expect(accepted(body)).toBe(true);
			expect(readDeviations(body).state).not.toBe("malformed");
		});
	}

	const refused: ReadonlyArray<readonly [string, string]> = [
		["a bare prose bullet", "Fixes #4312\n\n## Deviations\n\n- narrowed the scope a bit.\n"],
		["an empty section", "Fixes #4312\n\n## Deviations\n\n## Testing\n\nran it\n"],
		["no section at all", "Fixes #4312\n\ndid a thing.\n"],
		[
			"an entry missing a field",
			"Fixes #4312\n\n## Deviations\n\n- **Said:** a. **Did:** b. **Why:** c.\n",
		],
	];

	for (const [shape, body] of refused) {
		it(`refuses ${shape} at creation, where the review round used to catch it`, () => {
			expect(accepted(body)).toBe(false);
		});
	}
});
