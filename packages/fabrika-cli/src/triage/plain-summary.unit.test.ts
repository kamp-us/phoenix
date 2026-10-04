import {describe, expect, it} from "vitest";
import {PLAIN_SUMMARY_HEADING, readPlainSummary, renderPlainSummary} from "./plain-summary.ts";

const SUMMARY = "Writers lose their place after a save. We would keep focus put.";
const BODY = "## What to build\n\nKeep focus on the editor across a save.";

describe("readPlainSummary", () => {
	it("lifts the summary out of the top of stdin and keeps the rest", () => {
		expect(readPlainSummary(`${renderPlainSummary(SUMMARY)}\n\n${BODY}`)).toEqual({
			_tag: "Found",
			value: {summary: SUMMARY, body: BODY},
		});
	});

	it("lifts a summary sent BELOW the body, so its position is the verb's", () => {
		expect(readPlainSummary(`${BODY}\n\n${renderPlainSummary(SUMMARY)}\n`)).toEqual({
			_tag: "Found",
			value: {summary: SUMMARY, body: BODY},
		});
	});

	it("ends the section at its paragraph, so the pitch's field lines stay in the body", () => {
		const pitch = "**Problem:** x\n**Arc:** y";
		const read = readPlainSummary(`${PLAIN_SUMMARY_HEADING}\n\nLine one.\nLine two.\n\n${pitch}`);
		expect(read).toEqual({_tag: "Found", value: {summary: "Line one.\nLine two.", body: pitch}});
	});

	it("ends the section at the next heading even without a blank line", () => {
		const read = readPlainSummary(`${PLAIN_SUMMARY_HEADING}\nShort.\n## What to build\nx`);
		expect(read).toEqual({_tag: "Found", value: {summary: "Short.", body: "## What to build\nx"}});
	});

	it("reads a missing section as Missing", () => {
		expect(readPlainSummary(BODY)._tag).toBe("Missing");
	});

	it("reads a heading with no paragraph under it as Empty", () => {
		expect(readPlainSummary(`${PLAIN_SUMMARY_HEADING}\n\n${BODY}`)._tag).toBe("Empty");
		expect(readPlainSummary(`${BODY}\n\n${PLAIN_SUMMARY_HEADING}\n`)._tag).toBe("Empty");
	});

	it("does not accept a drifted heading as the section", () => {
		expect(readPlainSummary(`### In plain words\n\n${SUMMARY}\n\n${BODY}`)._tag).toBe("Missing");
	});

	it("refuses two sections as Repeated rather than picking one", () => {
		const twice = `${renderPlainSummary("a")}\n\n${BODY}\n\n${renderPlainSummary("b")}`;
		expect(readPlainSummary(twice)).toEqual({_tag: "Repeated", count: 2});
	});

	it("ignores a heading quoted inside a fenced block", () => {
		const quoted = `${renderPlainSummary(SUMMARY)}\n\n${BODY}\n\n\`\`\`\n${PLAIN_SUMMARY_HEADING}\n\`\`\``;
		const read = readPlainSummary(quoted);
		expect(read._tag).toBe("Found");
	});

	it("reads a summary with nothing else as Alone", () => {
		expect(readPlainSummary(renderPlainSummary(SUMMARY))._tag).toBe("Alone");
	});
});
