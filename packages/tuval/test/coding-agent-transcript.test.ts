import type {TranscriptItem} from "@earendil-works/pi-protocol";
import {assert, describe, it} from "vitest";
import {
	planTranscriptWindow,
	TRANSCRIPT_WINDOW_BYTE_LIMIT,
	TRANSCRIPT_WINDOW_LIMIT,
	transcriptOmissionMetadata,
} from "../src/backend/coding-agent-transcript.js";

const user = (index: number, text = `ileti-${index}`): TranscriptItem => ({
	id: `session:${index}`,
	role: "user",
	content: [{type: "text", text}],
	timestamp: index,
});

const userWithEncodedBytes = (index: number, bytes: number, character = "x"): TranscriptItem => {
	const empty = user(index, "");
	const overhead = Buffer.byteLength(JSON.stringify(empty), "utf8");
	const characterBytes = Buffer.byteLength(character, "utf8");
	const count = (bytes - overhead) / characterBytes;
	assert.ok(Number.isInteger(count) && count >= 0, "target must fit the selected UTF-8 character");
	const item = user(index, character.repeat(count));
	assert.equal(Buffer.byteLength(JSON.stringify(item), "utf8"), bytes);
	return item;
};

const toolPair = (index: number, resultText = "sonuç"): [TranscriptItem, TranscriptItem] => [
	{
		id: `session:${index}`,
		role: "assistant",
		content: [{type: "toolCall", toolCallId: `call-${index}`, toolName: "read", input: {}}],
		model: {provider: "fixture", id: "fixture"},
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
		},
		status: "complete",
		stopReason: "toolUse",
		timestamp: index,
	},
	{
		id: `session:${index + 1}`,
		role: "tool",
		toolCallId: `call-${index}`,
		toolName: "read",
		input: {},
		content: [{type: "text", text: resultText}],
		status: "complete",
		isError: false,
		timestamp: index + 1,
	},
];

const assertBounded = (plan: ReturnType<typeof planTranscriptWindow>): void => {
	assert.ok(plan.transcript.length <= TRANSCRIPT_WINDOW_LIMIT);
	assert.ok(plan.encodedBytes <= TRANSCRIPT_WINDOW_BYTE_LIMIT);
	assert.equal(plan.encodedBytes, Buffer.byteLength(JSON.stringify(plan.transcript), "utf8"));
};

const assertNoOrphanTools = (transcript: ReadonlyArray<TranscriptItem>): void => {
	for (let index = 0; index < transcript.length; index += 1) {
		const item = transcript[index];
		if (item?.role !== "tool") continue;
		const call = transcript[index - 1];
		assert.equal(call?.role, "assistant");
		assert.ok(
			call?.role === "assistant" &&
				call.content.some(
					(part) => part.type === "toolCall" && part.toolCallId === item.toolCallId,
				),
		);
	}
};

describe("coding-agent transcript window planner", () => {
	it("replaces the reproduced 256,100-byte item and advances past its source position", () => {
		const oversized = userWithEncodedBytes(0, 256_100);
		const plan = planTranscriptWindow([oversized]);

		assertBounded(plan);
		assert.equal(plan.sourceStart, 0);
		assert.equal(plan.sourceEnd, 1);
		assert.lengthOf(plan.transcript, 1);
		assert.deepInclude(transcriptOmissionMetadata(plan.transcript[0] as TranscriptItem), {
			reason: "oversized-item",
			omittedItemCount: 1,
			omittedByteCount: 256_100,
		});
	});

	it("measures multibyte UTF-8 and the exact encoded byte boundary including placeholders", () => {
		const emptyArrayBytes = Buffer.byteLength("[]", "utf8");
		assert.equal(emptyArrayBytes, 2);
		const exact = userWithEncodedBytes(0, TRANSCRIPT_WINDOW_BYTE_LIMIT - 2, "ş");
		const exactPlan = planTranscriptWindow([exact]);
		assert.equal(exactPlan.encodedBytes, TRANSCRIPT_WINDOW_BYTE_LIMIT);
		assert.equal(transcriptOmissionMetadata(exactPlan.transcript[0] as TranscriptItem), undefined);

		const oversized = userWithEncodedBytes(0, TRANSCRIPT_WINDOW_BYTE_LIMIT, "ş");
		const oversizedPlan = planTranscriptWindow([oversized]);
		assertBounded(oversizedPlan);
		assert.equal(
			transcriptOmissionMetadata(oversizedPlan.transcript[0] as TranscriptItem)?.reason,
			"oversized-item",
		);
	});

	it("admits exactly 40 items and leaves the 41st source item for the next page", () => {
		const exact = planTranscriptWindow(Array.from({length: 40}, (_, index) => user(index)));
		assertBounded(exact);
		assert.lengthOf(exact.transcript, 40);
		assert.equal(exact.sourceStart, 0);

		const over = planTranscriptWindow(Array.from({length: 41}, (_, index) => user(index)));
		assertBounded(over);
		assert.lengthOf(over.transcript, 40);
		assert.equal(over.sourceStart, 1);
	});

	it("keeps a boundary tool pair for the next page instead of expanding a window to 41 items", () => {
		const pair = toolPair(0);
		const transcript = [...pair, ...Array.from({length: 39}, (_, index) => user(index + 2))];
		const recent = planTranscriptWindow(transcript);
		assertBounded(recent);
		assert.lengthOf(recent.transcript, 39);
		assert.equal(recent.sourceStart, 2);
		assertNoOrphanTools(recent.transcript);

		const older = planTranscriptWindow(transcript, recent.sourceStart);
		assertBounded(older);
		assert.deepEqual(
			older.transcript.map(({id}) => id),
			pair.map(({id}) => id),
		);
		assertNoOrphanTools(older.transcript);
	});

	it("represents an oversized tool pair atomically with original counts", () => {
		const pair = toolPair(0, "ş".repeat(130_000));
		const plan = planTranscriptWindow(pair);
		assertBounded(plan);
		assert.lengthOf(plan.transcript, 1);
		assert.deepInclude(transcriptOmissionMetadata(plan.transcript[0] as TranscriptItem), {
			sourceStart: 0,
			sourceEnd: 2,
			omittedItemCount: 2,
			reason: "oversized-tool-pair",
		});
		assertNoOrphanTools(plan.transcript);
	});

	it("keeps a call with no retained result while turning an orphan result into omission", () => {
		const [call, orphan] = toolPair(0);
		const pending = planTranscriptWindow([call]);
		assertBounded(pending);
		assert.equal(transcriptOmissionMetadata(pending.transcript[0] as TranscriptItem), undefined);
		assert.equal(pending.transcript[0]?.role, "assistant");

		const plan = planTranscriptWindow([orphan]);
		assertBounded(plan);
		assert.equal(
			transcriptOmissionMetadata(plan.transcript[0] as TranscriptItem)?.reason,
			"invalid-tool-group",
		);
		assertNoOrphanTools(plan.transcript);
	});

	it("pages repeatedly with strict progress, exact count bounds, and no orphan events", () => {
		const oversized = userWithEncodedBytes(42, 256_100);
		const transcript = [
			...Array.from({length: 42}, (_, index) => user(index)),
			oversized,
			...toolPair(43, "ş".repeat(130_000)),
			...Array.from({length: 87}, (_, index) => user(index + 45)),
		];
		let before = transcript.length;
		let pages = 0;
		while (before > 0) {
			const page = planTranscriptWindow(transcript, before);
			assertBounded(page);
			assertNoOrphanTools(page.transcript);
			assert.ok(page.sourceStart < before, "a represented source group must advance the cursor");
			before = page.sourceStart;
			pages += 1;
			assert.ok(pages < 20, "paging stalled");
		}
		assert.ok(pages > 3);
	});
});
