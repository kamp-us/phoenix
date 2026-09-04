import {describe, expect, it} from "vitest";
import {
	boundToolResult,
	byteLength,
	ItemId,
	isTranscriptItem,
	TOOL_RESULT_BYTE_LIMIT,
	type TranscriptItem,
} from "./transcript-item.ts";

const at = 1_756_000_000_000;
const id = (value: string) => ItemId.make(value);

const user: TranscriptItem = {kind: "user", id: id("u1"), timestamp: at, text: "hi"};
const assistant: TranscriptItem = {kind: "assistant", id: id("a1"), timestamp: at, text: "hello"};
const system: TranscriptItem = {kind: "system", id: id("s1"), timestamp: at, text: "resumed"};
const tool: TranscriptItem = {
	kind: "tool",
	id: id("t1"),
	timestamp: at,
	name: "read_file",
	input: {path: "README.md"},
	result: {text: "ok", omitted: {bytes: 0}},
	status: "running",
};

describe("transcript item union", () => {
	it("admits all four kinds", () => {
		expect([user, assistant, system, tool].map(isTranscriptItem)).toEqual([true, true, true, true]);
	});

	it("admits an assistant turn the operator cut short", () => {
		expect(isTranscriptItem({...assistant, interrupted: true})).toBe(true);
	});

	it("refuses an item of an unknown kind", () => {
		expect(isTranscriptItem({...user, kind: "thinking"})).toBe(false);
	});

	it("refuses an item with no stable id or no timestamp", () => {
		expect(isTranscriptItem({...user, id: ""})).toBe(false);
		expect(isTranscriptItem({kind: "user", id: id("u1"), text: "hi"})).toBe(false);
	});

	it("refuses a tool item missing name, input, result or status", () => {
		expect(isTranscriptItem({...tool, name: 7})).toBe(false);
		expect(isTranscriptItem({...tool, input: () => 1})).toBe(false);
		expect(isTranscriptItem({...tool, result: "ok"})).toBe(false);
		expect(isTranscriptItem({...tool, status: "pending"})).toBe(false);
	});

	it("refuses a tool result past the per-item byte bound, however it was built", () => {
		const oversized = "x".repeat(TOOL_RESULT_BYTE_LIMIT + 1);
		expect(isTranscriptItem({...tool, result: {text: oversized, omitted: {bytes: 0}}})).toBe(false);
	});

	it("refuses a tool result whose omission metadata is missing or negative", () => {
		expect(isTranscriptItem({...tool, result: {text: "ok"}})).toBe(false);
		expect(isTranscriptItem({...tool, result: {text: "ok", omitted: {bytes: -1}}})).toBe(false);
	});
});

describe("boundToolResult", () => {
	it("passes a result already inside the bound through whole", () => {
		expect(boundToolResult("small")).toEqual({text: "small", omitted: {bytes: 0}});
	});

	it("cuts an oversized result to the bound and reports the bytes left out", () => {
		const raw = "x".repeat(TOOL_RESULT_BYTE_LIMIT + 250);
		const bounded = boundToolResult(raw);
		expect(byteLength(bounded.text)).toBe(TOOL_RESULT_BYTE_LIMIT);
		expect(bounded.omitted.bytes).toBe(250);
	});

	it("cuts on a code-point boundary, so a multi-byte character is never split", () => {
		const bounded = boundToolResult("ağaç".repeat(4), 5);
		expect(bounded.text).toBe("ağa");
		expect(bounded.text).not.toContain("�");
		expect(byteLength(bounded.text) + bounded.omitted.bytes).toBe(byteLength("ağaç".repeat(4)));
	});

	it("produces a result its own predicate admits", () => {
		const bounded = boundToolResult("y".repeat(TOOL_RESULT_BYTE_LIMIT * 2));
		expect(isTranscriptItem({...tool, result: bounded, status: "ok"})).toBe(true);
	});
});
