/**
 * `parseLiveControlRequest` decode contract for the closed live-topic set. The
 * one non-obvious guarantee under test: a `subscribeConnection` on a REGISTERED
 * procedure (`savedPosts`, the per-viewer saved list) decodes instead of failing
 * with the `BAD_REQUEST` the unregistered procedure returned (#2214), while an
 * unknown procedure still fails closed.
 *
 * Unit tier (ADR 0082): pure decode, no storage, no platform fake.
 */

import {assert, it} from "@effect/vitest";
import {Effect} from "effect";
import {expectTypeOf, it as vit} from "vitest";
import {
	type ConnectionId,
	type EntityId,
	type LiveControlOperation,
	type LiveControlRequest,
	LiveTopic,
	parseLiveControlRequest,
} from "./protocol.ts";

const subscribeConnectionRequest = (procedure: string) => ({
	version: 1,
	connectionId: "c1",
	operations: [
		{
			id: "op1",
			kind: "subscribeConnection",
			type: "Post",
			procedure,
			select: ["id"],
		},
	],
});

it.effect("decodes a subscribeConnection on the registered savedPosts topic", () =>
	Effect.gen(function* () {
		const decoded = yield* parseLiveControlRequest(
			subscribeConnectionRequest(LiveTopic.savedPosts),
		);
		const op = decoded.operations[0];
		if (op?.kind !== "subscribeConnection") {
			return assert.fail(`expected a subscribeConnection op, got ${op?.kind}`);
		}
		assert.strictEqual(op.procedure, "savedPosts");
	}),
);

it.effect("rejects a subscribeConnection on an unregistered procedure with BAD_REQUEST", () =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(
			parseLiveControlRequest(subscribeConnectionRequest("notATopic")),
		);
		assert.strictEqual(error.code, "BAD_REQUEST");
	}),
);

// A connectionId/entityId swap fails typecheck: the two live-protocol ids carry
// distinct nominal brands, so neither is assignable to the other and the decoded
// `LiveControlRequest`/subscribe-op surfaces expose the branded types. Pinned with
// expectTypeOf, not `@ts-expect-error` — the effect LSP plugin's TS377003 escapes the
// directive (see vote-boundary.unit.test.ts). This is the type-level half of the guard;
// the decode tests above cover the byte-identical runtime.
vit("connectionId and entityId are distinct branded surfaces", () => {
	// Each id is branded, not a bare string / bare union (the brand is what a swap trips).
	expectTypeOf<ConnectionId>().not.toEqualTypeOf<string>();
	expectTypeOf<EntityId>().not.toEqualTypeOf<string | number>();
	// The two brands are distinct, so a connectionId can't stand in for an entityId.
	expectTypeOf<ConnectionId>().not.toEqualTypeOf<EntityId>();
	// The decoded protocol surfaces expose the branded types (not bare strings/unions).
	expectTypeOf<LiveControlRequest["connectionId"]>().toEqualTypeOf<ConnectionId>();
	expectTypeOf<
		Extract<LiveControlOperation, {kind: "subscribe"}>["entityId"]
	>().toEqualTypeOf<EntityId>();
});
