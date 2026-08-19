/**
 * `parseLiveControlRequest` decode contract. The non-obvious guarantee: a
 * `subscribeConnection` on a REGISTERED procedure decodes rather than returning the
 * `BAD_REQUEST` an unregistered one did (#2214), while an unknown procedure still fails
 * closed.
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

// Pinned with expectTypeOf, not `@ts-expect-error` — the effect LSP plugin's TS377003
// escapes the directive (see vote-boundary.unit.test.ts).
vit("connectionId and entityId are distinct branded surfaces", () => {
	expectTypeOf<ConnectionId>().not.toEqualTypeOf<string>();
	expectTypeOf<EntityId>().not.toEqualTypeOf<string | number>();
	expectTypeOf<ConnectionId>().not.toEqualTypeOf<EntityId>();
	expectTypeOf<LiveControlRequest["connectionId"]>().toEqualTypeOf<ConnectionId>();
	expectTypeOf<
		Extract<LiveControlOperation, {kind: "subscribe"}>["entityId"]
	>().toEqualTypeOf<EntityId>();
});
