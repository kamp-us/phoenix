/**
 * The guard `session-transcript.ts` is written against: the wire union and the ports union are two
 * statements of one thing, so each has to admit exactly what the other does.
 *
 * Drift here is silent. The two agreeing today is not the point — the point is that a new `kind`
 * on one side, or a number arm the other refuses, turns a real transcript into "cannot read as a
 * transcript" on the page, with nothing failing until an operator sees it.
 */

import {assert, describe, it} from "@effect/vitest";
import {Result, Schema} from "effect";
import {
	boundToolResult,
	ItemId,
	isTranscriptItem,
	TOOL_RESULT_BYTE_LIMIT,
	type TranscriptItem,
} from "../ai-agent/ports/index.ts";
import {SessionTranscript, TranscriptItem as TranscriptItemSchema} from "./session-transcript.ts";

const AT = 1_756_000_000_000;

/** Every shape the ports predicate admits: four kinds, both optional keys, nested tool input. */
const admitted: ReadonlyArray<readonly [string, TranscriptItem]> = [
	["a user turn", {kind: "user", id: ItemId.make("u1"), timestamp: AT, text: "hello"}],
	[
		"a user turn the core recorded locally",
		{kind: "user", id: ItemId.make("u2"), timestamp: AT, text: "hello", local: true},
	],
	["an assistant turn", {kind: "assistant", id: ItemId.make("a1"), timestamp: AT, text: "hi"}],
	[
		"an interrupted assistant turn",
		{kind: "assistant", id: ItemId.make("a2"), timestamp: AT, text: "hi", interrupted: true},
	],
	[
		"an assistant turn a subagent wrote",
		{
			kind: "assistant",
			id: ItemId.make("a3"),
			timestamp: AT,
			text: "hi",
			parentId: ItemId.make("t1"),
		},
	],
	["a system line", {kind: "system", id: ItemId.make("s1"), timestamp: AT, text: "resumed"}],
	[
		"a system line with a folded detail",
		{kind: "system", id: ItemId.make("s2"), timestamp: AT, text: "hook ran", detail: "exit 0"},
	],
	["a thinking row", {kind: "thinking", id: ItemId.make("th1"), timestamp: AT, text: "weighing"}],
	[
		"a thinking row a subagent reasoned out",
		{
			kind: "thinking",
			id: ItemId.make("th2"),
			timestamp: AT,
			text: "weighing",
			parentId: ItemId.make("t1"),
		},
	],
	[
		"a compaction marker",
		{kind: "compaction", id: ItemId.make("c1"), timestamp: AT, text: "context compacted"},
	],
	[
		"a tool call over nested JSON input",
		{
			kind: "tool",
			id: ItemId.make("t1"),
			timestamp: AT,
			name: "read_file",
			input: {path: "README.md", opts: [1, true, null, {deep: "yes"}]},
			result: boundToolResult("ok"),
			status: "ok",
		},
	],
	[
		"a nested tool call still running",
		{
			kind: "tool",
			id: ItemId.make("t2"),
			timestamp: AT,
			name: "spawn_agent",
			input: null,
			result: boundToolResult("x".repeat(TOOL_RESULT_BYTE_LIMIT + 100)),
			status: "running",
			parentId: ItemId.make("t1"),
		},
	],
];

/** Every shape the ports predicate refuses. The wire has to refuse each one too. */
const refused: ReadonlyArray<readonly [string, unknown]> = [
	["an empty id", {kind: "user", id: "", timestamp: AT, text: "hello"}],
	["a NaN timestamp", {kind: "user", id: "u1", timestamp: Number.NaN, text: "hello"}],
	["an infinite timestamp", {kind: "system", id: "s1", timestamp: Infinity, text: "resumed"}],
	[
		"a non-finite number inside tool input",
		{
			kind: "tool",
			id: "t1",
			timestamp: AT,
			name: "read_file",
			input: {ratio: Number.NaN},
			result: {text: "ok", omitted: {bytes: 0}},
			status: "ok",
		},
	],
	[
		"a tool result past the port's byte bound",
		{
			kind: "tool",
			id: "t1",
			timestamp: AT,
			name: "read_file",
			input: null,
			result: {text: "x".repeat(TOOL_RESULT_BYTE_LIMIT + 1), omitted: {bytes: 0}},
			status: "ok",
		},
	],
	[
		"a negative omission",
		{
			kind: "tool",
			id: "t1",
			timestamp: AT,
			name: "read_file",
			input: null,
			result: {text: "ok", omitted: {bytes: -1}},
			status: "ok",
		},
	],
	[
		"an unknown tool status",
		{
			kind: "tool",
			id: "t1",
			timestamp: AT,
			name: "read_file",
			input: null,
			result: {text: "ok", omitted: {bytes: 0}},
			status: "cancelled",
		},
	],
	["a seventh kind", {kind: "verdict", id: "x1", timestamp: AT, text: "hmm"}],
];

const decodeItem = Schema.decodeUnknownResult(TranscriptItemSchema);

describe("the wire union and the ports union", () => {
	for (const [name, item] of admitted) {
		it(`both admit ${name}`, () => {
			assert.isTrue(isTranscriptItem(item));
			const decoded = decodeItem(item);
			assert.isTrue(Result.isSuccess(decoded));
			if (Result.isSuccess(decoded)) assert.deepStrictEqual(decoded.success, item);
		});
	}

	for (const [name, value] of refused) {
		it(`both refuse ${name}`, () => {
			assert.isFalse(isTranscriptItem(value));
			assert.isTrue(Result.isFailure(decodeItem(value)));
		});
	}

	it("admits nothing the ports predicate would refuse", () => {
		for (const [, value] of refused) {
			const decoded = decodeItem(value);
			if (Result.isSuccess(decoded)) {
				assert.fail(`the wire decoded ${JSON.stringify(value)}, which the port refuses`);
			}
		}
	});
});

describe("one page of a transcript", () => {
	it("carries its items oldest first and a cursor for the page before it", () => {
		const page = {items: admitted.map(([, item]) => item), next: "u1"};
		const decoded = Schema.decodeUnknownResult(SessionTranscript)(page);
		assert.isTrue(Result.isSuccess(decoded));
		if (Result.isSuccess(decoded)) assert.deepStrictEqual(decoded.success, page);
	});

	it("reads a null cursor as the beginning of history", () => {
		const decoded = Schema.decodeUnknownResult(SessionTranscript)({items: [], next: null});
		assert.isTrue(Result.isSuccess(decoded));
		if (Result.isSuccess(decoded)) assert.strictEqual(decoded.success.next, null);
	});

	it("refuses a page carrying an item the port would refuse", () => {
		const [, bad] = refused[0] as readonly [string, unknown];
		assert.isTrue(
			Result.isFailure(Schema.decodeUnknownResult(SessionTranscript)({items: [bad], next: null})),
		);
	});
});
