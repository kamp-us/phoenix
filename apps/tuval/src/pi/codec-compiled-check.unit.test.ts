/**
 * The behavior pin for the `@earendil-works/pi-protocol` patch (ADR 0364): the codec's validators
 * are built once and reused, so validating a long transcript costs microseconds rather than seconds.
 *
 * @patch-pin: @earendil-works/pi-protocol@0.84.3
 *
 * Two claims, and the pin needs both. Speed alone would pass on a codec that validated nothing;
 * correctness alone would pass on the unpatched codec that is correct and unusably slow.
 */

import {
	encodeServerMessage,
	ProtocolValidationError,
	type ServerMessage,
	ServerMessageDecoder,
	type TranscriptItem,
} from "@earendil-works/pi-protocol";
import {assert, describe, it} from "@effect/vitest";

const AT = 1_760_000_000_000;
const MODEL = {provider: "openai", id: "gpt-6-astra"} as const;

const textItem = (id: string): TranscriptItem => ({
	id,
	role: "assistant",
	content: [{type: "text", text: "x".repeat(400)}],
	model: MODEL,
	timestamp: AT,
	status: "complete",
	stopReason: "stop",
});

/**
 * A tool item is what the patch is *for*: its `input` and `details` are the protocol's `Type.Cyclic`
 * `JsonValue`, and re-resolving that `$ref` per node is the whole of the uncompiled cost. A pin over
 * text items alone would not move between the patched and unpatched codec.
 */
const toolItem = (id: string): TranscriptItem => ({
	id,
	role: "tool",
	toolCallId: `tc-${id}`,
	toolName: "Read",
	input: {file: `/a/b/${id}.ts`, opts: {limit: 100, nested: {deep: [1, 2, 3, "s"]}}},
	content: [{type: "text", text: "file contents ".repeat(20)}],
	timestamp: AT,
	status: "complete",
	isError: false,
});

const snapshotOf = (items: ReadonlyArray<TranscriptItem>): ServerMessage => ({
	type: "event",
	event: {
		type: "session_snapshot",
		snapshot: {
			id: "s1",
			cwd: "/work",
			createdAt: AT,
			updatedAt: AT,
			phase: "turn",
			model: MODEL,
			thinkingLevel: "high",
			attached: true,
			locked: true,
			revision: 42,
			transcript: [...items],
			queuedSteer: [],
			queuedSteerCount: 0,
		},
	},
});

/** The transcript a real working session reaches: half prose, half tool calls. */
const longTranscript = (count: number): ReadonlyArray<TranscriptItem> =>
	Array.from({length: count}, (_, index) =>
		index % 2 === 0 ? textItem(`i${index}`) : toolItem(`i${index}`),
	);

const ITEMS = 300;

/**
 * Measured on the patched codec: ~2 ms for the round trip below. Unpatched it is ~10 s, because the
 * uncompiled `Check` runs once on the encode and once more on the decode. The ceiling sits three
 * orders of magnitude above the patched cost and three below the unpatched one, so neither a slow
 * machine nor a warm one can move the verdict.
 */
const CEILING_MS = 1_000;

describe("the pi-protocol codec's compiled validators", () => {
	it("round-trips a 300-item transcript far below the uncompiled cost", () => {
		const message = snapshotOf(longTranscript(ITEMS));
		// Warm the lazy compile, so the ceiling measures validation and not the one-time ~170 ms build.
		new ServerMessageDecoder().push(encodeServerMessage(message));

		const started = performance.now();
		const [decoded] = new ServerMessageDecoder().push(encodeServerMessage(message));
		const elapsed = performance.now() - started;

		assert.isDefined(decoded, "the frame decoded to nothing");
		assert.strictEqual(decoded?.type, "event");
		assert.isBelow(
			elapsed,
			CEILING_MS,
			`encode+decode of a ${ITEMS}-item snapshot took ${elapsed.toFixed(0)}ms — the codec is validating uncompiled`,
		);
	});

	// An empty id is the refusal a *well-typed* message can still carry: `IdSchema` is
	// `Type.String({minLength: 1})`, whose static type is plain `string`, so only the validator can
	// catch it. That is what makes this a test of the compiled validator rather than of a cast.
	it("still refuses a message the schema does not admit", () => {
		const message = snapshotOf([{...textItem("i0"), id: ""}]);
		assert.throws(() => encodeServerMessage(message), ProtocolValidationError);
	});

	it("still admits a message the schema does admit", () => {
		const message = snapshotOf(longTranscript(4));
		const [decoded] = new ServerMessageDecoder().push(encodeServerMessage(message));
		assert.deepStrictEqual(decoded, message);
	});
});
