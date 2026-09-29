/**
 * Hearthstone Battlegrounds Live Relay Routes.
 * - POST /api/hsbg/rooms/:roomId — publishes player game state into LiveDO topic.
 * - GET  /api/hsbg/rooms/:roomId/state — gets latest snapshot.
 */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {defaultLiveLimits} from "../fate-live/protocol.ts";
import {LiveTopics} from "../fate-live/topics.ts";

class HsbgPayloadError extends Schema.TaggedError<HsbgPayloadError>()("hsbg/HsbgPayloadError", {
	cause: Schema.Defect(),
}) {}

// In-memory isolate cache for direct HTTP GET reads
const ROOM_SNAPSHOTS = new Map<string, unknown>();

const roomIdOf = (requestUrl: string): string =>
	new URL(requestUrl).pathname.match(/\/api\/hsbg\/rooms\/([^/]+)/)?.[1] ?? "default";

export const handlePublishHsbgState = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const topics = yield* LiveTopics;
	const roomId = roomIdOf(raw.url);

	const payload = yield* Effect.tryPromise({
		try: () => raw.json(),
		catch: (cause) => new HsbgPayloadError({cause}),
	});
	ROOM_SNAPSHOTS.set(roomId, payload);

	// Publish to LiveDO subscribers
	yield* topics
		.publish(
			`hsbg:${roomId}`,
			{
				kind: "entity",
				match: {type: "HSBGRoom", entityId: roomId},
				frame: {data: payload},
			},
			defaultLiveLimits,
		)
		.pipe(Effect.ignore);

	return HttpServerResponse.jsonUnsafe({ok: true, room: roomId});
}).pipe(
	Effect.catchTag("hsbg/HsbgPayloadError", () =>
		Effect.succeed(
			HttpServerResponse.jsonUnsafe({ok: false, error: "invalid JSON body"}, {status: 400}),
		),
	),
);

export const handleGetHsbgState = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const snapshot = ROOM_SNAPSHOTS.get(roomIdOf(raw.url));
	if (!snapshot) {
		return HttpServerResponse.jsonUnsafe({error: "Room not active or not found"}, {status: 404});
	}
	return HttpServerResponse.jsonUnsafe(snapshot);
});

export const hsbgPublishRoute = HttpRouter.add(
	"POST",
	"/api/hsbg/rooms/:roomId",
	handlePublishHsbgState,
);

export const hsbgGetRoute = HttpRouter.add("GET", "/api/hsbg/rooms/:roomId", handleGetHsbgState);
