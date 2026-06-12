/**
 * `livePublisherFor` — the worker-side live implementation of the package's
 * `LivePublisher` per-request service.
 *
 * The contract under test, in order:
 *
 *   1. the error channel of every publish method is `never` — "a publish
 *      cannot fail the mutation" is a TYPE, the whole point of the service
 *      (type-level assertions);
 *   2. the published `(topicKey, PublishMessage)` pairs match the established
 *      wire shape — pinned against literal frame fixtures AND against the
 *      frozen byte baseline recorded from the retired bridge event-bus
 *      (`makeLiveEventBus`, deleted when the publisher took over
 *      frame-building from the bus — these pins are the drift guard);
 *   3. a publish whose underlying topic call rejects cannot fail the calling
 *      effect (failing topic stub);
 *   4. publishes are scheduled through the request's execution context
 *      (`waitUntil`), never awaited on the request path (slow topic stub —
 *      the calling effect completes while the publish is still in flight).
 *
 * T0 per ADR 0040: stubs at the topic seam, zero storage, no platform fake.
 */

import {assert, it} from "@effect/vitest";
import {liveConnectionTopic, liveEntityTopic, liveGlobalConnectionTopic} from "@nkzw/fate/server";
import type {LivePublisher} from "@phoenix/fate-effect";
import {Effect, Exit} from "effect";
import {expectTypeOf, vi} from "vitest";
import {livePublisherFor} from "./live-publisher.ts";
import type {PublishMessage} from "./protocol.ts";

interface Recorded {
	readonly topicKey: string;
	readonly message: PublishMessage;
}

/**
 * Build a `LivePublisher` service value over stubbed seams: `publish` defaults
 * to a recorder, `waitUntil` collects the scheduled promises so a test can
 * flush (or deliberately NOT flush) the fire-and-forget work.
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
	return {live, recorded, scheduled, flush};
}

it("every publish method's error channel is `never` — the no-fail contract is the type", () => {
	type Publisher = typeof LivePublisher.Service;
	expectTypeOf<Effect.Error<ReturnType<Publisher["update"]>>>().toEqualTypeOf<never>();
	expectTypeOf<Effect.Error<ReturnType<Publisher["delete"]>>>().toEqualTypeOf<never>();
	type Connection = ReturnType<Publisher["connection"]>;
	expectTypeOf<Effect.Error<ReturnType<Connection["appendNode"]>>>().toEqualTypeOf<never>();
	expectTypeOf<Effect.Error<ReturnType<Connection["prependNode"]>>>().toEqualTypeOf<never>();
	expectTypeOf<Effect.Error<ReturnType<Connection["deleteEdge"]>>>().toEqualTypeOf<never>();
	expectTypeOf<Effect.Error<ReturnType<Connection["invalidate"]>>>().toEqualTypeOf<never>();

	// The live value implements exactly the package's service shape — no wider,
	// no narrower; a drift in either direction is a compile error here.
	const {live} = makeHarness();
	expectTypeOf(live).toEqualTypeOf<typeof LivePublisher.Service>();
});

it.effect("publishes the bridge's exact wire frames (literal fixtures)", () =>
	Effect.gen(function* () {
		const {live, recorded, flush} = makeHarness();

		// `changed` is accepted but does NOT reach the wire — the bridge's update
		// frame carries `data` only (no `select` mask); pinned by the fixture below.
		yield* live.update("Definition", "d1", {
			data: {id: "d1", body: "updated"},
			changed: ["body"],
			eventId: "e1",
		});
		yield* live.delete("Post", 7, {eventId: "e2"});
		const definitions = live.connection("Term.definitions", {slug: "effect"});
		yield* definitions.appendNode("Definition", "d2", {
			node: {id: "d2"},
			cursor: "c1",
			eventId: "e3",
		});
		yield* definitions.prependNode("Definition", "d3", {node: {id: "d3"}});
		yield* definitions.deleteEdge("Definition", "d2", {eventId: "e4"});
		yield* definitions.invalidate({eventId: "e5"});
		// no-args connection → the procedure-wide global wildcard topic
		yield* live.connection("posts").appendNode("Post", "p1", {node: {id: "p1"}});
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

it.effect("wire shape is identical to the retired event bus for the same mutation calls", () =>
	Effect.gen(function* () {
		// The live surface...
		const {live, recorded, flush} = makeHarness();
		yield* live.update("Definition", "d1", {eventId: "e1"});
		yield* live.delete("Post", 7, {eventId: "e2"});
		const definitions = live.connection("Term.definitions", {slug: "effect"});
		yield* definitions.appendNode("Definition", "d2", {
			node: {id: "d2"},
			cursor: "c1",
			eventId: "e3",
		});
		yield* definitions.prependNode("Definition", "d3", {node: {id: "d3"}});
		yield* definitions.deleteEdge("Definition", "d2", {eventId: "e4"});
		yield* definitions.invalidate({eventId: "e5"});
		yield* live.connection("posts").appendNode("Post", "p1", {node: {id: "p1"}});
		yield* Effect.promise(flush);

		// ...and the FROZEN baseline: the exact `(topicKey, message)` pairs the
		// bridge's `makeLiveEventBus` recorded for these same calls before its
		// deletion (when the publisher took over frame-building) — the bus's
		// output for this corpus, frozen as
		// literal bytes. Note `frame: {data: undefined}`: an update without
		// `data` still carried the `data` key (the bus spelled `{data:
		// options?.data}`), and the publisher must keep doing so.
		const bridgeRecorded: Array<Recorded> = [
			{
				topicKey: liveEntityTopic("Definition", "d1"),
				message: {
					kind: "entity",
					match: {type: "Definition", entityId: "d1"},
					frame: {data: undefined},
					eventId: "e1",
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
				topicKey: liveConnectionTopic("Term.definitions", {slug: "effect"}),
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
				topicKey: liveConnectionTopic("Term.definitions", {slug: "effect"}),
				message: {
					kind: "connection",
					match: {procedure: "Term.definitions", args: {slug: "effect"}},
					frame: {type: "prependNode", nodeType: "Definition", edge: {node: {id: "d3"}}},
				},
			},
			{
				topicKey: liveConnectionTopic("Term.definitions", {slug: "effect"}),
				message: {
					kind: "connection",
					match: {procedure: "Term.definitions", args: {slug: "effect"}},
					frame: {type: "deleteEdge", nodeType: "Definition", id: "d2"},
					eventId: "e4",
				},
			},
			{
				topicKey: liveConnectionTopic("Term.definitions", {slug: "effect"}),
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
		];

		assert.deepStrictEqual(recorded, bridgeRecorded);
	}),
);

it.effect("a rejecting topic publish cannot fail the calling effect", () => {
	// Silences the publisher's failure log so the run stays quiet — asserts nothing.
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	return Effect.gen(function* () {
		const {live, flush} = makeHarness(() => Effect.die(new Error("DO unreachable")));

		const exit = yield* Effect.exit(
			live.connection("Term.definitions", {slug: "effect"}).appendNode("Definition", "d1"),
		);
		assert.isTrue(Exit.isSuccess(exit)); // the mutation-side effect succeeded...

		yield* Effect.promise(flush); // ...and the detached failure stayed off the caller
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
		yield* Effect.promise(flush); // drain the waitUntil-scheduled work
		assert.isTrue(settled); // the scheduled work genuinely ran to completion
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
		assert.isTrue(Exit.isSuccess(exit)); // ...yet the calling effect succeeded
	}),
);
