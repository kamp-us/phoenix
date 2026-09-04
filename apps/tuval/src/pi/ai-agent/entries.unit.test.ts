/**
 * Pi's JSONL entries → the port items `page` walks. Hand-built entries, because the shapes that
 * matter here — a compaction standing in for turns that are gone, an extension's own message the
 * wire does not carry — are ones a faux session will not produce on demand.
 */

import type {SessionEntry} from "@earendil-works/pi-coding-agent";
import {describe, expect, it} from "vitest";
import {pageItems} from "./entries.ts";

const at = (seconds: number): string => new Date(1_760_000_000_000 + seconds * 1_000).toISOString();

const message = (id: string, parent: string | null, seconds: number, body: unknown): SessionEntry =>
	({
		type: "message",
		id,
		parentId: parent,
		timestamp: at(seconds),
		message: body,
	}) as SessionEntry;

const said = (text: string) => ({
	role: "user" as const,
	content: [{type: "text" as const, text}],
	timestamp: 0,
});

const replied = (text: string) => ({
	role: "assistant" as const,
	content: [{type: "text" as const, text}],
	provider: "faux",
	model: "faux-1",
	stopReason: "stop",
	timestamp: 0,
});

describe("a session branch as pageable history", () => {
	it("keys each item by its entry and reads the entry's clock", () => {
		const items = pageItems([
			message("e1", null, 1, said("older question")),
			message("e2", "e1", 2, replied("older answer")),
		]);
		expect(items).toEqual([
			{kind: "user", id: "e1", timestamp: Date.parse(at(1)), text: "older question"},
			{kind: "assistant", id: "e2", timestamp: Date.parse(at(2)), text: "older answer"},
		]);
	});

	it("carries a tool call's arguments onto the result that names it", () => {
		const items = pageItems([
			message("e1", null, 1, said("read it")),
			message("e2", "e1", 2, {
				role: "assistant",
				content: [{type: "toolCall", id: "call-1", name: "read_file", arguments: {path: "a.md"}}],
				provider: "faux",
				model: "faux-1",
				stopReason: "toolUse",
				timestamp: 0,
			}),
			message("e3", "e2", 3, {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read_file",
				content: [{type: "text", text: "file body"}],
				isError: false,
				timestamp: 0,
			}),
		]);
		const tool = items.at(-1);
		expect(tool).toEqual({
			kind: "tool",
			id: "call-1",
			timestamp: Date.parse(at(3)),
			name: "read_file",
			input: {path: "a.md"},
			result: {text: "file body", omitted: {bytes: 0}},
			status: "ok",
		});
	});

	it("renders a compaction as the system item that stands for the turns it replaced", () => {
		const items = pageItems([
			{
				type: "compaction",
				id: "e1",
				parentId: null,
				timestamp: at(1),
				summary: "we agreed on the plan",
				firstKeptEntryId: "e0",
				tokensBefore: 4_000,
			} as SessionEntry,
			message("e2", "e1", 2, said("carry on")),
		]);
		expect(items).toEqual([
			{kind: "system", id: "e1", timestamp: Date.parse(at(1)), text: "we agreed on the plan"},
			{kind: "user", id: "e2", timestamp: Date.parse(at(2)), text: "carry on"},
		]);
	});

	it("skips a message the wire does not carry without shifting the entries after it", () => {
		const items = pageItems([
			message("e1", null, 1, {role: "extension-only", content: [], timestamp: 0}),
			message("e2", "e1", 2, said("still mine")),
		]);
		expect(items).toEqual([
			{kind: "user", id: "e2", timestamp: Date.parse(at(2)), text: "still mine"},
		]);
	});
});
