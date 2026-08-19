/** Unit tier (ADR 0082): stubs at the topic seam, zero storage, no platform fake. */

import {assert, it} from "@effect/vitest";
import type {LivePublisher} from "@kampus/fate-effect";
import {liveConnectionTopic, liveEntityTopic, liveGlobalConnectionTopic} from "@nkzw/fate/server";
import {Effect, Exit} from "effect";
import * as Schema from "effect/Schema";
import {expectTypeOf, vi} from "vitest";
import {LiveTransportError} from "./cold-start-retry.ts";
import {livePublisherFor} from "./live-publisher.ts";
import type {PublishMessage} from "./protocol.ts";

class PromiseRejected extends Schema.TaggedErrorClass<PromiseRejected>()("test/PromiseRejected", {
	cause: Schema.Unknown,
}) {}

interface Recorded {
	readonly topicKey: string;
	readonly message: PublishMessage;
}

/**
 * `waitUntil` collects the scheduled promises so a test can `flush` — or
 * deliberately NOT flush — the fire-and-forget work.
 */
function makeHarness(
	publish?: (topicKey: string, message: PublishMessage) => Effect.Effect<void, LiveTransportError>,
) {
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

	const {live} = makeHarness();
	expectTypeOf(live).toEqualTypeOf<typeof LivePublisher.Service>();
});

it.effect("publishes the bridge's exact wire frames (literal fixtures)", () =>
	Effect.gen(function* () {
		const {live, recorded, flush} = makeHarness();

		// `changed` is accepted but does NOT reach the wire.
		yield* live.update("Definition", "d1", {
			data: {id: "d1", body: "updated"},
			changed: ["body"],
			eventId: "e1",
		});
		// An update with no `data` still carries the `data` key on the wire.
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
		yield* Effect.tryPromise({try: flush, catch: (cause) => new PromiseRejected({cause})}).pipe(
			Effect.orDie,
		);

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
	// Silence the publisher's Warn failure log so the run stays quiet.
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	return Effect.gen(function* () {
		const {live, flush} = makeHarness(() => Effect.die(new Error("DO unreachable")));

		const exit = yield* Effect.exit(
			live.topic("Term.definitions", {slug: "effect"}).appendNode("Definition", "d1"),
		);
		assert.isTrue(Exit.isSuccess(exit));

		yield* Effect.tryPromise({try: flush, catch: (cause) => new PromiseRejected({cause})}).pipe(
			Effect.orDie,
		); // the detached failure stays off the caller
	}).pipe(
		Effect.ensuring(
			Effect.sync(() => {
				logSpy.mockRestore();
			}),
		),
	);
});

it.effect(
	"an exhausted-cold-start publish is logged through the Effect logger, never a bare console.error or a silent drop (#2551)",
	() => {
		// The regression: a bare `console.error` on the detached publish's terminal catch
		// was invisible to the Effect logger and to Sentry breadcrumbs, so a lost
		// invalidation was silent by construction. The detached fiber runs on the default
		// runtime, whose logger sink is the real `console.log` this test captures.
		const logged: Array<string> = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation((...args: Array<unknown>) => {
			logged.push(args.map(String).join(" "));
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		return Effect.gen(function* () {
			const {live, flush} = makeHarness(() =>
				Effect.fail(new LiveTransportError({method: "publish", cause: new Error("cold topic DO")})),
			);

			const exit = yield* Effect.exit(
				live.topic("Term.definitions", {slug: "effect"}).invalidate(),
			);
			assert.isTrue(Exit.isSuccess(exit), "the mutation never fails on an exhausted publish");

			yield* Effect.tryPromise({try: flush, catch: (cause) => new PromiseRejected({cause})}).pipe(
				Effect.orDie,
			);
			assert.isTrue(
				logged.some((line) => line.includes("live publish to topic:")),
				"the exhausted publish was logged through the Effect logger",
			);
			assert.strictEqual(errorSpy.mock.calls.length, 0, "off the bare console.error sink");
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					logSpy.mockRestore();
					errorSpy.mockRestore();
				}),
			),
		);
	},
);

it.effect("a slow publish does not block the request path — waitUntil carries it", () =>
	Effect.gen(function* () {
		let release: () => void = () => {};
		let settled = false;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const {live, flush} = makeHarness(() =>
			Effect.tryPromise({
				try: () =>
					gate.then(() => {
						settled = true;
					}),
				catch: (cause) => new PromiseRejected({cause}),
			}).pipe(Effect.orDie),
		);

		// Completes NOW, while the topic call is still hung — nothing on the request
		// path awaits it.
		yield* live.update("Definition", "d1", {data: {id: "d1"}});
		assert.isFalse(settled);

		release();
		yield* Effect.tryPromise({try: flush, catch: (cause) => new PromiseRejected({cause})}).pipe(
			Effect.orDie,
		);
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
				// biome-ignore lint/plugin: throw is in a nested plain closure (test stub), not the Effect.gen body — lexical matcher can't exempt
				throw new Error("execution context gone");
			},
		});

		const exit = yield* Effect.exit(live.delete("Post", "p1"));
		assert.strictEqual(attempts, 1); // the schedule was attempted (and threw)
		assert.isTrue(Exit.isSuccess(exit)); // yet the calling effect succeeded
	}),
);
