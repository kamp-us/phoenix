/**
 * Driven by `fixtures/agent-a1b2c3d4e5f60718a.jsonl` and its `.meta.json` — a real subagent run
 * captured off an operator's own CLI store, sanitized per `fixtures/PROVENANCE.md`.
 */

import {describe, expect, it} from "vitest";
import {loadSidechain, SIDECHAIN_AGENT_ID} from "./fixtures/load.ts";
import {
	isSidechainRefusal,
	readSidechain,
	sidechainFileName,
	sidechainMetaName,
	UNNAMED_SUBAGENT,
} from "./sidechain.ts";

const AT = 1_700_000_000_000;
const capture = loadSidechain();

describe("readSidechain over a captured subagent", () => {
	const read = readSidechain(capture, {at: AT});

	it("answers the transcript oldest first, one item per thing that happened", () => {
		expect(read.kind).toBe("transcript");
		if (isSidechainRefusal(read)) return;
		expect(read.items.map((one) => one.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
		expect(read.items.map((one) => one.timestamp)).toEqual([
			Date.parse("2026-07-22T08:10:08.771Z"),
			Date.parse("2026-07-22T08:10:12.074Z"),
			Date.parse("2026-07-22T08:10:12.118Z"),
			Date.parse("2026-07-22T08:10:14.590Z"),
		]);
	});

	it("settles the tool row the way toHistoryItems settles one — the call, with its answer on it", () => {
		if (isSidechainRefusal(read)) throw new Error("the capture did not read");
		const tool = read.items.find((one) => one.kind === "tool");
		expect(tool).toEqual({
			kind: "tool",
			id: "toolu_00000000000000000000002",
			timestamp: Date.parse("2026-07-22T08:10:12.118Z"),
			name: "Grep",
			input: {pattern: "probe", path: "."},
			status: "error",
			parentId: "toolu_00000000000000000000001",
			result: {
				text: "<tool_use_error>Error: No such tool available: Grep. Grep is not available in this session — search file contents with `grep` via the Bash tool instead.</tool_use_error>",
				omitted: {bytes: 0},
			},
		});
	});

	it("takes the subagent's type off the meta file", () => {
		if (isSidechainRefusal(read)) throw new Error("the capture did not read");
		expect(read.type).toBe("probe-plugin:probe-grep");
	});

	it("reads past the rows the SDK's own wire form has no arm for", () => {
		if (isSidechainRefusal(read)) throw new Error("the capture did not read");
		expect(read.skipped).toBe(0);
	});
});

describe("the meta file", () => {
	it("degrades to an unnamed subagent when it is absent", () => {
		const read = readSidechain({jsonl: capture.jsonl, meta: null}, {at: AT});
		expect(isSidechainRefusal(read)).toBe(false);
		if (isSidechainRefusal(read)) return;
		expect(read.type).toBe(UNNAMED_SUBAGENT);
		expect(read.items.length).toBeGreaterThan(0);
	});

	it("degrades the same way when it will not parse, rather than failing the read", () => {
		const read = readSidechain({jsonl: capture.jsonl, meta: "{not json"}, {at: AT});
		if (isSidechainRefusal(read)) throw new Error("an unparseable meta file failed the read");
		expect(read.type).toBe(UNNAMED_SUBAGENT);
	});

	it("degrades the same way when it parses but names no type", () => {
		const read = readSidechain({jsonl: capture.jsonl, meta: '{"spawnDepth":1}'}, {at: AT});
		if (isSidechainRefusal(read)) throw new Error("a typeless meta file failed the read");
		expect(read.type).toBe(UNNAMED_SUBAGENT);
	});
});

describe("a line that will not parse", () => {
	const broken = (lines: ReadonlyArray<string>) =>
		readSidechain({jsonl: lines.join("\n"), meta: capture.meta}, {at: AT});

	it("refuses and names the line, rather than dropping it", () => {
		const lines = capture.jsonl.trim().split("\n");
		const read = broken([...lines.slice(0, 2), "{oh no", ...lines.slice(2)]);
		expect(read).toEqual({
			kind: "refused",
			reason: "malformed-line",
			line: 3,
			detail: expect.any(String),
		});
	});

	it("refuses a line that is JSON but not an object", () => {
		const read = broken(["[1,2,3]"]);
		expect(isSidechainRefusal(read)).toBe(true);
		if (!isSidechainRefusal(read)) return;
		expect(read.line).toBe(1);
	});

	it("never answers an empty transcript in place of one", () => {
		const read = broken(["{oh no"]);
		expect(isSidechainRefusal(read)).toBe(true);
	});
});

describe("the file names the CLI writes", () => {
	it("are the two the store opens", () => {
		expect(sidechainFileName(SIDECHAIN_AGENT_ID)).toBe(`agent-${SIDECHAIN_AGENT_ID}.jsonl`);
		expect(sidechainMetaName(SIDECHAIN_AGENT_ID)).toBe(`agent-${SIDECHAIN_AGENT_ID}.meta.json`);
	});
});
