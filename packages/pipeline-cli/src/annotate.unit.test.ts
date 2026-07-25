import {describe, expect, it} from "vitest";
import {
	annotationsEnabled,
	atFile,
	atLine,
	formatWorkflowCommand,
	gateFailureAnnotations,
	renderAnnotations,
	unlocated,
} from "./annotate.ts";

describe("formatWorkflowCommand", () => {
	it("renders an unlocated error as a bare workflow command", () => {
		expect(formatWorkflowCommand(unlocated("error", "guard failed"))).toBe("::error::guard failed");
	});

	it("renders a file location", () => {
		expect(formatWorkflowCommand(atFile("error", "packages/x/package.json", "hardcoded"))).toBe(
			"::error file=packages/x/package.json::hardcoded",
		);
	});

	it("renders a file+line location", () => {
		expect(formatWorkflowCommand(atLine("warning", "a/b.ts", 12, "stale"))).toBe(
			"::warning file=a/b.ts,line=12::stale",
		);
	});

	it("escapes the message so a newline cannot terminate the command early", () => {
		expect(formatWorkflowCommand(unlocated("error", "one\ntwo\r\n100% off"))).toBe(
			"::error::one%0Atwo%0D%0A100%25 off",
		);
	});

	it("escapes `,` and `:` in a property value, which would otherwise end the property", () => {
		expect(formatWorkflowCommand(atFile("error", "a,b:c.ts", "x"))).toBe(
			"::error file=a%2Cb%3Ac.ts::x",
		);
	});
});

describe("annotationsEnabled", () => {
	it("is on under a GitHub Actions runner", () => {
		expect(annotationsEnabled({GITHUB_ACTIONS: "true"})).toBe(true);
	});

	it("is off locally", () => {
		expect(annotationsEnabled({})).toBe(false);
		expect(annotationsEnabled({GITHUB_ACTIONS: ""})).toBe(false);
	});

	it("is off when explicitly disabled", () => {
		expect(annotationsEnabled({GITHUB_ACTIONS: "false"})).toBe(false);
	});
});

describe("renderAnnotations", () => {
	const annotations = [unlocated("error", "boom"), atFile("error", "a.ts", "bad")];

	it("emits one command per annotation under Actions", () => {
		expect(renderAnnotations(annotations, {GITHUB_ACTIONS: "true"})).toEqual([
			"::error::boom",
			"::error file=a.ts::bad",
		]);
	});

	it("emits nothing outside Actions, so local output is unchanged", () => {
		expect(renderAnnotations(annotations, {})).toEqual([]);
	});
});

describe("gateFailureAnnotations", () => {
	it("keeps a guard's own located annotations", () => {
		const own = [atLine("error", "a.ts", 3, "bad")];
		expect(gateFailureAnnotations("report text", own)).toEqual(own);
	});

	it("falls back to one bare error carrying the report head", () => {
		expect(gateFailureAnnotations("catalog-guard: 2 deps pin hardcoded versions")).toEqual([
			unlocated("error", "catalog-guard: 2 deps pin hardcoded versions"),
		]);
	});

	it("truncates a long report so one annotation cannot swallow the whole log", () => {
		const reason = Array.from({length: 20}, (_, i) => `line ${i}`).join("\n");
		const [annotation] = gateFailureAnnotations(reason);
		expect(annotation?.message.split("\n")).toHaveLength(8);
	});

	it("emits nothing for an empty reason rather than a blank annotation", () => {
		expect(gateFailureAnnotations("   \n  ")).toEqual([]);
	});
});
