/**
 * `livePromoteContext` — the shared test layer for the #1886 post-promote
 * live-publish. Any promotion case that reaches a `promoted: true` flip now fires
 * `publishPromotion`, which re-resolves the promoted `User` (`Pasaport.getUsersByIds`
 * + the `moderatorsAmong` `RelationStore.hasSubjects` join) and publishes through
 * `LivePublisher`. This bundles a fail-safe default for all three so an existing
 * case that only ASSERTS on the notification/receipt keeps compiling and passing
 * without re-scripting each seam.
 *
 * A case that ASSERTS on the published frame builds its own recording
 * `LivePublisher` instead (see `promote-live.unit.test.ts`).
 */
import {RelationStore} from "@kampus/authz";
import {LivePublisher} from "@kampus/fate-effect";
import {Effect, Layer} from "effect";
import {livePublisherFor} from "../fate-live/live-publisher.ts";

/**
 * A silently-succeeding `LivePublisher` — delivery is a no-op and `waitUntil`
 * drops the detached work; a case that reaches a landed flip publishes into the
 * void, so the publish neither fails nor is asserted on here.
 */
export const noopLive: Layer.Layer<LivePublisher> = Layer.succeed(LivePublisher)(
	livePublisherFor({
		publish: () => Effect.void,
		waitUntil: () => {},
	}),
);

/**
 * A `RelationStore` where nobody moderates — the `isModerator` re-resolve join
 * reads `hasSubjects`; a promoted yazar need not be a moderator, so the empty
 * membership is the realistic default. `has` stays fail-on-contact (unreached).
 */
export const relationStoreNoModerators: Layer.Layer<RelationStore> = Layer.succeed(RelationStore, {
	has: () => Effect.die(new Error("moderatorsAmong reads hasSubjects, not has")),
	hasSubjects: () => Effect.succeed(new Set<string>()),
	subjectsOf: () => Effect.succeed(new Set<string>()),
});

/**
 * The bundle a landed-flip case needs so `publishPromotion`'s three seams resolve:
 * the no-op publisher + the no-moderators relation store. `Pasaport.getUsersByIds`
 * is provided by the case's own `makePasaportStub` (the record the flip promoted).
 */
export const livePromoteContext: Layer.Layer<LivePublisher | RelationStore> = Layer.mergeAll(
	noopLive,
	relationStoreNoModerators,
);
