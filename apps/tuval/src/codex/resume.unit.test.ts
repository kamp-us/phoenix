import {describe, expect, it} from "vitest";
import {ItemId, type TranscriptItem} from "../ai-agent/ports/index.ts";
import {resumeItems} from "./resume.ts";

const history = [
	{id: ItemId.make("u"), kind: "user", text: "hello", timestamp: 1},
	{id: ItemId.make("a"), kind: "assistant", text: "hi", timestamp: 2},
	{id: ItemId.make("b"), kind: "assistant", text: "next", timestamp: 3},
] as const satisfies ReadonlyArray<TranscriptItem>;

describe("Codex resume replay", () => {
	it("paints the complete history when the window holds nothing", () => {
		expect(resumeItems(history, {sessionId: "session", holdsTranscript: false})).toEqual(history);
	});
	it("does not flood a restored tail with older history or unchanged rows", () => {
		expect(
			resumeItems(history, {sessionId: "session", holdsTranscript: true, held: [history[1]]}),
		).toEqual([history[2]]);
	});
	it("replays a row that completed while disconnected and anything after it", () => {
		const held: TranscriptItem = {
			id: ItemId.make("a"),
			kind: "assistant",
			text: "h",
			timestamp: 2,
			partial: true,
		};
		expect(
			resumeItems(history, {sessionId: "session", holdsTranscript: true, held: [held]}),
		).toEqual(history.slice(1));
	});
	it("does not mistake a history timestamp fallback for changed content", () => {
		const held: TranscriptItem = {
			id: ItemId.make("b"),
			kind: "assistant",
			text: "next",
			timestamp: 900,
		};
		expect(
			resumeItems(history, {sessionId: "session", holdsTranscript: true, held: [held]}),
		).toEqual([]);
	});
	it("replays everything when no held row occurs in backend history", () => {
		expect(resumeItems(history, {sessionId: "session", holdsTranscript: true, held: []})).toEqual(
			history,
		);
	});
});
