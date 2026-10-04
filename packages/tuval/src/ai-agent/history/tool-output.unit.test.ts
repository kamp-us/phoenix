import {describe, expect, it} from "vitest";
import {randomTranscript, toolItem, userItem} from "../../ai-agent-fixtures/transcripts.ts";
import {byteLength, type ToolItem} from "../ports/index.ts";
import {boundToolOutput, droppedResultBytes, type RawToolItem} from "./tool-output.ts";

const raw = (output: string): RawToolItem => {
	const {result: _result, ...rest} = toolItem("t1") as ToolItem;
	return {...rest, output};
};

describe("the per-item tool output bound", () => {
	it("keeps every other field of the item it bounded", () => {
		const item = boundToolOutput(raw("x".repeat(20)), 4);
		expect({id: item.id, name: item.name, status: item.status, input: item.input}).toEqual({
			id: "t1",
			name: "read_file",
			status: "ok",
			input: {path: "README.md"},
		});
		expect(item.result.omitted.bytes).toBe(16);
	});

	it("holds the bound over random outputs, whatever their length", () => {
		const failures: Array<string> = [];
		for (let length = 0; length <= 400; length += 7) {
			const text = "ağaç".repeat(length);
			const item = boundToolOutput(raw(text), 64);
			const kept = byteLength(item.result.text);
			if (kept > 64) failures.push(`${length}: kept ${kept} bytes`);
			if (kept + item.result.omitted.bytes !== byteLength(text)) {
				failures.push(`${length}: kept plus omitted is not the whole output`);
			}
		}
		expect(failures).toEqual([]);
	});
});

describe("droppedResultBytes", () => {
	it("sums what the per-item bound cut across a slice, ignoring non-tool items", () => {
		const items = [userItem("u1"), boundToolOutput(raw("x".repeat(30)), 10)];
		expect(droppedResultBytes(items)).toBe(20);
	});

	it("is zero for a transcript whose results all fit", () => {
		expect(droppedResultBytes(randomTranscript(3))).toBe(0);
	});
});
