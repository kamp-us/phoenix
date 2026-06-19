import {assert, describe, it} from "@effect/vitest";
import {parseReadSet} from "./transcript.ts";

const line = (obj: unknown): string => JSON.stringify(obj);

const readEntry = (filePath: string, timestamp: string): string =>
	line({
		timestamp,
		message: {content: [{type: "tool_use", name: "Read", input: {file_path: filePath}}]},
	});

describe("parseReadSet — reconstruct the read-set from transcript JSONL", () => {
	it("extracts a Read tool_use as {path, readAtMs}", () => {
		const t = readEntry("/repo/a.ts", "2026-06-19T10:00:00.000Z");
		const rs = parseReadSet(t);
		assert.strictEqual(rs.length, 1);
		assert.strictEqual(rs[0]?.path, "/repo/a.ts");
		assert.strictEqual(rs[0]?.readAtMs, Date.parse("2026-06-19T10:00:00.000Z"));
	});

	it("captures multiple reads across lines", () => {
		const t = [
			readEntry("/repo/a.ts", "2026-06-19T10:00:00.000Z"),
			readEntry("/repo/b.ts", "2026-06-19T10:01:00.000Z"),
		].join("\n");
		assert.strictEqual(parseReadSet(t).length, 2);
	});

	it("ignores non-Read tool_use blocks (Edit/Bash/etc.)", () => {
		const t = line({
			timestamp: "2026-06-19T10:00:00.000Z",
			message: {content: [{type: "tool_use", name: "Edit", input: {file_path: "/repo/a.ts"}}]},
		});
		assert.strictEqual(parseReadSet(t).length, 0);
	});

	it("skips malformed JSON lines without throwing", () => {
		const t = [
			"not json at all",
			readEntry("/repo/a.ts", "2026-06-19T10:00:00.000Z"),
			"{also bad",
		].join("\n");
		const rs = parseReadSet(t);
		assert.strictEqual(rs.length, 1);
		assert.strictEqual(rs[0]?.path, "/repo/a.ts");
	});

	it("skips an entry with no/invalid timestamp", () => {
		const t = line({
			message: {content: [{type: "tool_use", name: "Read", input: {file_path: "/repo/a.ts"}}]},
		});
		assert.strictEqual(parseReadSet(t).length, 0);
	});

	it("skips a Read tool_use missing file_path", () => {
		const t = line({
			timestamp: "2026-06-19T10:00:00.000Z",
			message: {content: [{type: "tool_use", name: "Read", input: {}}]},
		});
		assert.strictEqual(parseReadSet(t).length, 0);
	});

	it("returns empty on an empty / blank transcript", () => {
		assert.strictEqual(parseReadSet("").length, 0);
		assert.strictEqual(parseReadSet("\n  \n").length, 0);
	});
});
