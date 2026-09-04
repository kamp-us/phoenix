import {describe, expect, it} from "vitest";
import {
	assistantItem,
	randomTranscript,
	systemItem,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";
import {groupTranscript, itemBytes, locateCursor} from "./groups.ts";

describe("atomic groups", () => {
	it("keeps a prompt, its answer and the tools between them in one group", () => {
		const history = [
			userItem("u1"),
			assistantItem("a1"),
			toolItem("t1"),
			toolItem("t2"),
			userItem("u2"),
			assistantItem("a2"),
		];
		expect(groupTranscript(history).map((group) => group.items.map((item) => item.id))).toEqual([
			["u1", "a1", "t1", "t2"],
			["u2", "a2"],
		]);
	});

	it("stands a session notice alone, so it splits nothing around it", () => {
		const history = [userItem("u1"), assistantItem("a1"), systemItem("s1"), userItem("u2")];
		expect(groupTranscript(history).map((group) => group.items.length)).toEqual([2, 1, 1]);
	});

	it("opens an orphan group for a turn with no prompt before it", () => {
		const history = [assistantItem("a1"), toolItem("t1"), userItem("u1"), assistantItem("a2")];
		expect(groupTranscript(history).map((group) => group.items.map((item) => item.id))).toEqual([
			["a1", "t1"],
			["u1", "a2"],
		]);
	});

	it("covers every item of any generated transcript exactly once, in order", () => {
		for (let seed = 1; seed <= 50; seed += 1) {
			const history = randomTranscript(seed);
			const flattened = groupTranscript(history).flatMap((group) => [...group.items]);
			expect({seed, ids: flattened.map((item) => item.id)}).toEqual({
				seed,
				ids: history.map((item) => item.id),
			});
		}
	});

	it("reports each group's start index and byte weight off its own items", () => {
		const notice = systemItem("s1");
		const prompt = userItem("u1");
		const answer = assistantItem("a1");
		const groups = groupTranscript([notice, prompt, answer]);
		expect(groups.map((group) => group.start)).toEqual([0, 1]);
		expect(groups.map((group) => group.bytes)).toEqual([
			itemBytes(notice),
			itemBytes(prompt) + itemBytes(answer),
		]);
	});
});

describe("cursor location", () => {
	const history = [userItem("u1"), assistantItem("a1"), toolItem("t1"), userItem("u2")];
	const groups = groupTranscript(history);

	it("finds a cursor that opens a group", () => {
		expect(locateCursor(history, groups, "u2")).toEqual({kind: "found", group: 1, index: 3});
	});

	it("calls a cursor inside a group a split", () => {
		expect(locateCursor(history, groups, "t1")).toEqual({kind: "splits-group", index: 2});
	});

	it("calls an id nobody carries absent", () => {
		expect(locateCursor(history, groups, "nope")).toEqual({kind: "absent"});
	});
});
