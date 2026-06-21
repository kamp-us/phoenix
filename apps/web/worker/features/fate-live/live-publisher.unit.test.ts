/**
 * `livePublisherFor` — the worker-side live implementation of the package's
 * `LivePublisher` per-request service. The contract under test:
 *
 *   1. every publish method's error channel is `never` ("a publish cannot fail
 *      the mutation" is a TYPE);
 *   2. the published `(topicKey, PublishMessage)` pairs match the wire shape —
 *      pinned against literal fixtures (the drift guard), including the no-`data`
 *      update frame;
 *   3. a rejecting topic call cannot fail the calling effect;
 *   4. publishes are scheduled through `waitUntil`, never awaited on the request
 *      path.
 *
 * T0 per ADR 0040: stubs at the topic seam, zero storage, no platform fake.
 */

import {assert, it} from "@effect/vitest";
import type {LivePublisher} from "@kampus/fate-effect";
import {liveConnectionTopic, liveEntityTopic, liveGlobalConnectionTopic} from "@nkzw/fate/server";
import {Effect, Exit} from "effect";
import {expectTypeOf, vi} from "vitest";
import {livePublisherFor} from "./live-publisher.ts";
import type {PublishMessage} from "./protocol.ts";

interface Recorded {
	readonly topicKey: string;
	readonly message: PublishMessage;
}

/**
 * Build a `LivePublisher` over stubbed seams: `publish` defaults to a recorder,
 * `waitUntil` collects the scheduled promises so a test can `flush` (or
 * deliberately NOT flush) the fire-and-forget work.
 */
function makeHarness(publish?: (topicKey: string, message: PublishMessage) => Effect.Effect<void>) {
	const recorded: Array<Recorded> = [];
	const scheduled: Array<Promise<unknown>> = [];
	const live = livePublisherFor({
		publish:
			publish ??
			((topicKey, message) =>
				Effect.sync(() => {
					recorded.push({topicKey, message});
				})),
		waitUntil: (promise) => {
			scheduled.push(promise);
		},
	});
	const flush = () => Promise.allSettled(scheduled);
	return {live, recorded, flush};
}

it("every publish method's error channel is `never` — the no-fail contract is the type", () => {
	type Publisher = typeof LivePublisher.Service;
	expectTypeOf<Effect.Error<ReturnType<Publisher["update"]>>>().toEqualTypeOf<never>();
	expectTypeOf<Effect.Error<ReturnType<Publisher["delete"]>>>().toEqualTypeOf<never>();
	type Topic = ReturnType<Publisher["topic"]>;
	expectTypeOf<Effect.Error<ReturnType<Topic["appendNode"]>>>().toEqualTypeOf<never>();
	expectTypeOf<Effect.Error<ReturnType<Topic["prependNode"]>>>().toEqualTypeOf<never>();
	expectTypeOf<Effect.Error<ReturnType<Topic["deleteEdge"]>>>().toEqualTypeOf<never>();
	expectTypeOf<Effect.Error<ReturnType<Topic["invalidate"]>>>().toEqualTypeOf<never>();

	// The live value implements exactly the package's service shape — a drift in
	// either direction is a compile error here.
	const {live} = makeHarness();
	expectTypeOf(live).toEqualTypeOf<typeof LivePublisher.Service>();
});

it.effect("publishes the bridge's exact wire frames (literal fixtures)", () =>
	Effect.gen(function* () {
		const {live, recorded, flush} = makeHarness();

		// `changed` is accepted but does NOT reach the wire — the update frame carries
		// `data` only (no `select` mask); pinned by the fixture below.
		yield* live.update("Definition", "d1", {
			data: {id: "d1", body: "updated"},
			changed: ["body"],
			eventId: "e1",
		});
		// An update with no `data` still carries the `data` key on the wire
		// (`frame: {data: undefined}`) — asserted by the fixture below.
		yield* live.update("Definition", "d9", {eventId: "e9"});
		yield* live.delete("Post", 7, {eventId: "e2"});
		const definitions = live.topic("Term.definitions", {slug: "effect"});
		yield* definitions.appendNode("Definition", "d2", {
			node: {id: "d2"},
			cursor: "c1",
			eventId: "e3",
		});
		yield* definitions.prependNode("Definition", "d3", {node: {id: "d3"}});
		yield* definitions.deleteEdge("Definition", "d2", {eventId: "e4"});
		yield* definitions.invalidate({eventId: "e5"});
		// no-args topic → the procedure-wide global wildcard topic
		yield* live.topic("posts").appendNode("Post", "p1", {node: {id: "p1"}});
		yield* Effect.promise(flush);

		const definitionsTopic = liveConnectionTopic("Term.definitions", {slug: "effect"});
		assert.deepStrictEqual(recorded, [
			{
				topicKey: liveEntityTopic("Definition", "d1"),
				message: {
					kind: "entity",
					match: {type: "Definition", entityId: "d1"},
					frame: {data: {id: "d1", body: "updated"}},
					eventId: "e1",
				},
			},
			{
				topicKey: liveEntityTopic("Definition", "d9"),
				message: {
					kind: "entity",
					match: {type: "Definition", entityId: "d9"},
					frame: {data: undefined},
					eventId: "e9",
				},
			},
			{
				topicKey: liveEntityTopic("Post", 7),
				message: {
					kind: "entity",
					match: {type: "Post", entityId: "7"},
					frame: {delete: true, id: 7},
					eventId: "e2",
				},
			},
			{
				topicKey: definitionsTopic,
				message: {
					kind: "connection",
					match: {procedure: "Term.definitions", args: {slug: "effect"}},
					frame: {
						type: "appendNode",
						nodeType: "Definition",
						edge: {node: {id: "d2"}, cursor: "c1"},
					},
					eventId: "e3",
				},
			},
			{
				topicKey: definitionsTopic,
				message: {
					kind: "connection",
					match: {procedure: "Term.definitions", args: {slug: "effect"}},
					frame: {type: "prependNode", nodeType: "Definition", edge: {node: {id: "d3"}}},
				},
			},
			{
				topicKey: definitionsTopic,
				message: {
					kind: "connection",
					match: {procedure: "Term.definitions", args: {slug: "effect"}},
					frame: {type: "deleteEdge", nodeType: "Definition", id: "d2"},
					eventId: "e4",
				},
			},
			{
				topicKey: definitionsTopic,
				message: {
					kind: "connection",
					match: {procedure: "Term.definitions", args: {slug: "effect"}},
					frame: {type: "invalidate"},
					eventId: "e5",
				},
			},
			{
				topicKey: liveGlobalConnectionTopic("posts"),
				message: {
					kind: "connection",
					match: {procedure: "posts"},
					frame: {type: "appendNode", nodeType: "Post", edge: {node: {id: "p1"}}},
				},
			},
		]);
	}),
);

it.effect("a rejecting topic publish cannot fail the calling effect", () => {
	// Silence the publisher's failure log so the run stays quiet.
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	return Effect.gen(function* () {
		const {live, flush} = makeHarness(() => Effect.die(new Error("DO unreachable")));

		const exit = yield* Effect.exit(
			live.topic("Term.definitions", {slug: "effect"}).appendNode("Definition", "d1"),
		);
		assert.isTrue(Exit.isSuccess(exit));

		yield* Effect.promise(flush); // the detached failure stays off the caller
	}).pipe(
		Effect.ensuring(
			Effect.sync(() => {
				errorSpy.mockRestore();
			}),
		),
	);
});

it.effect("a slow publish does not block the request path — waitUntil carries it", () =>
	Effect.gen(function* () {
		let release: () => void = () => {};
		let settled = false;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const {live, flush} = makeHarness(() =>
			Effect.promise(() =>
				gate.then(() => {
					settled = true;
				}),
			),
		);

		// The publish effect completes NOW, while the topic call is still hung —
		// nothing on the request path awaits it.
		yield* live.update("Definition", "d1", {data: {id: "d1"}});
		assert.isFalse(settled);

		release();
		yield* Effect.promise(flush);
		assert.isTrue(settled);
	}),
);

it.effect("a synchronously-throwing execution context is swallowed too", () =>
	Effect.gen(function* () {
		let attempts = 0;
		const live = livePublisherFor({
			publish: () => Effect.void,
			waitUntil: () => {
				attempts += 1;
				throw new Error("execution context gone");
			},
		});

		const exit = yield* Effect.exit(live.delete("Post", "p1"));
		assert.strictEqual(attempts, 1); // the schedule was attempted (and threw)
		assert.isTrue(Exit.isSuccess(exit)); // yet the calling effect succeeded
	}),
);
