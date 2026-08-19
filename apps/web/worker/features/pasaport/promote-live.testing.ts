/**
 * The shared test layer for the post-promote live-publish. Any promotion case reaching a
 * `promoted: true` flip fires `publishPromotion`, which touches three seams; this bundles a
 * fail-safe default for all of them so a case that only asserts on the notification keeps
 * passing without re-scripting each seam. A case that ASSERTS on the published frame builds
 * its own recording `LivePublisher` instead.
 */
import {RelationStore} from "@kampus/authz";
import {LivePublisher} from "@kampus/fate-effect";
import {Effect, Layer} from "effect";
import {livePublisherFor} from "../fate-live/live-publisher.ts";

/** Delivery is a no-op and `waitUntil` drops the detached work — a publish into the void. */
export const noopLive: Layer.Layer<LivePublisher> = Layer.succeed(LivePublisher)(
	livePublisherFor({
		publish: () => Effect.void,
		waitUntil: () => {},
	}),
);

/**
 * Nobody moderates: a promoted yazar need not be a moderator, so empty membership is the
 * realistic default. `has` stays fail-on-contact (unreached).
 */
export const relationStoreNoModerators: Layer.Layer<RelationStore> = Layer.succeed(RelationStore, {
	has: () => Effect.die(new Error("moderatorsAmong reads hasSubjects, not has")),
	hasSubjects: () => Effect.succeed(new Set<string>()),
	subjectsOf: () => Effect.succeed(new Set<string>()),
});

/**
 * `Pasaport.getUsersByIds` is provided by the case's own `makePasaportStub` (the record the
 * flip promoted), so only the other two seams are bundled here.
 */
export const livePromoteContext: Layer.Layer<LivePublisher | RelationStore> = Layer.mergeAll(
	noopLive,
	relationStoreNoModerators,
);
