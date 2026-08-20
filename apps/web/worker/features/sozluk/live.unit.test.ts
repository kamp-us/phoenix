/**
 * `sozlukLive` — the definition publish seam. Pins that an entity `update` fans a
 * viewer-blind payload: the node it carries is re-resolved against the MUTATOR's
 * `SandboxViewer`, and fate merges that node key-by-key over every subscriber's cache,
 * so the reader-facing çaylak marker must not ride along (#6462).
 */
import {assert, it} from "@effect/vitest";
import {Effect} from "effect";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import type {PublishMessage} from "../fate-live/protocol.ts";
import {sozlukLive} from "./live.ts";
import {toDefinition} from "./shapers.ts";

function capturingPublisher() {
	const messages: Array<PublishMessage> = [];
	const live = livePublisherFor({
		publish: (_topicKey, message) => {
			messages.push(message);
			return Effect.void;
		},
		waitUntil: () => {},
	});
	return {live, messages};
}

const publishedData = (messages: ReadonlyArray<PublishMessage>): Record<string, unknown> => {
	const [message] = messages;
	if (message === undefined || message.kind !== "entity" || !("data" in message.frame)) {
		throw new Error("expected exactly one entity frame carrying a data payload");
	}
	return message.frame.data as Record<string, unknown>;
};

const markedDefinition = toDefinition({
	id: "d1",
	body: "bir tanım",
	score: 2,
	author: "bir çaylak",
	authorId: "u-caylak",
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-02T00:00:00.000Z"),
	sandboxedInPlace: true,
});

it.effect("a definition update publishes no sandboxedInPlace key", () =>
	Effect.gen(function* () {
		const {live, messages} = capturingPublisher();

		yield* sozlukLive(live).definition.update("d1", {
			changed: ["score"],
			data: markedDefinition,
		});

		const data = publishedData(messages);
		assert.isFalse("sandboxedInPlace" in data);
		// The rest of the node still rides — this drops one key, it does not gut the frame.
		assert.strictEqual(data.score, 2);
	}),
);
