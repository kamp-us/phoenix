import {describe, expect, it} from "vitest";
import {
	annotationsEnabled,
	atFile,
	atLine,
	fallbackAnnotations,
	formatWorkflowCommand,
	renderAnnotations,
	unlocated,
} from "./annotate.ts";

describe("formatWorkflowCommand", () => {
	it("renders each location shape GitHub parses", () => {
		expect(formatWorkflowCommand(unlocated("error", "boom"))).toBe("::error::boom");
		expect(formatWorkflowCommand(atFile("warning", "a/b.ts", "boom"))).toBe(
			"::warning file=a/b.ts::boom",
		);
		expect(formatWorkflowCommand(atLine("notice", "a/b.ts", 12, "boom"))).toBe(
			"::notice file=a/b.ts,line=12::boom",
		);
	});

	// A raw newline would terminate the command early and swallow the rest of the message.
	it("escapes the message bytes that would end the command", () => {
		expect(formatWorkflowCommand(unlocated("error", "one\ntwo\rthree 100%"))).toBe(
			"::error::one%0Atwo%0Dthree 100%25",
		);
	});

	// In the property head a `,` ends the property and a `:` ends the head, so both need escaping
	// on top of the data escapes — a Windows-shaped path would otherwise truncate the command.
	it("escapes the property bytes that would end the property head", () => {
		expect(formatWorkflowCommand(atFile("error", "a,b:c.ts", "boom"))).toBe(
			"::error file=a%2Cb%3Ac.ts::boom",
		);
	});
});

describe("annotationsEnabled", () => {
	it("is on under Actions and off everywhere else", () => {
		expect(annotationsEnabled({GITHUB_ACTIONS: "true"})).toBe(true);
		expect(annotationsEnabled({})).toBe(false);
		expect(annotationsEnabled({GITHUB_ACTIONS: ""})).toBe(false);
		expect(annotationsEnabled({GITHUB_ACTIONS: "false"})).toBe(false);
	});
});

describe("renderAnnotations", () => {
	it("emits nothing off a runner, whatever it was handed", () => {
		expect(renderAnnotations([unlocated("error", "boom")], {})).toEqual([]);
	});

	it("emits one line per annotation on a runner", () => {
		expect(
			renderAnnotations([unlocated("error", "a"), atFile("error", "b.ts", "b")], {
				GITHUB_ACTIONS: "true",
			}),
		).toEqual(["::error::a", "::error file=b.ts::b"]);
	});
});

describe("fallbackAnnotations", () => {
	it("keeps the guard's own annotations when it supplied any", () => {
		const own = [atFile("error", "a.ts", "mine")];
		expect(fallbackAnnotations("report", own)).toBe(own);
	});

	// A red that renders a blank check surface is the #3868 complaint verbatim.
	it("manufactures one bare ::error from the report head when it supplied none", () => {
		const annotations = fallbackAnnotations("line one\nline two");
		expect(annotations).toHaveLength(1);
		expect(annotations[0]?.location).toEqual({_tag: "Unlocated"});
		expect(annotations[0]?.message).toBe("line one\nline two");
	});

	it("bounds how much of a long report rides in the fallback", () => {
		const report = Array.from({length: 40}, (_, i) => `line ${i}`).join("\n");
		expect(fallbackAnnotations(report)[0]?.message.split("\n")).toHaveLength(8);
	});

	it("manufactures nothing from an empty report — there is no message to carry", () => {
		expect(fallbackAnnotations("   \n  ")).toEqual([]);
	});
});
