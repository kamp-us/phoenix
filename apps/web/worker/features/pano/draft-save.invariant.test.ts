/**
 * `post.saveDraft` returns a `Post` carrying `isDraft: true` — the taslak write's
 * wire contract (#746; the dark-ship flag that once gated it is retired, ADR 0136).
 *
 * Wire-boundary unit test (ADR 0082): the `Pano`/`LivePublisher` seams are
 * substituted directly — no DB, no Flagship binding. The mutation runs through
 * `resolveWire` (its real external interface — `resolve` decode + the
 * `encodeWireError` class→wire-code seam) rather than `.handler`, so the decode
 * of the returned selection is part of what's proven. Mirrors
 * `report-mutation.unit.test.ts` (`resolveWire` + `CurrentUser`).
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {mutations} from "./mutations.ts";
import {Pano, type SaveDraftResult} from "./Pano.ts";

const AUTHOR = {id: "u-author", email: "elif@example.com", name: "elif"};

const runtimeContextStub: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

// A `LivePublisher` that records nothing — the publish is fire-and-forget and its
// error channel is `never`, so it can never fail the mutation.
const liveStub = Layer.succeed(LivePublisher)(
	livePublisherFor({publish: () => Effect.void, waitUntil: () => {}}),
);

// A `Pano` stub whose `saveDraft` is scripted; every other method dies, so an
// unexpected service call is loud rather than silently satisfied.
const panoStub = (saveDraft: (typeof Pano.Service)["saveDraft"]): Layer.Layer<Pano> =>
	Layer.succeed(
		Pano,
		new Proxy({saveDraft} as Partial<typeof Pano.Service>, {
			get(target, prop) {
				if (prop in target) return (target as Record<string, unknown>)[prop as string];
				return () => Effect.die(`Pano.${String(prop)} not exercised in draft-save.invariant`);
			},
		}) as typeof Pano.Service,
	);

const draftRow: SaveDraftResult = {
	postId: "post_draft1",
	title: "yarım kalmış",
	url: null,
	host: null,
	body: null,
	authorId: AUTHOR.id,
	authorName: AUTHOR.name,
	score: 0,
	commentCount: 0,
	tags: [],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	isDraft: true,
};

const saveDraft = (pano: Layer.Layer<Pano>, user: typeof AUTHOR | undefined = AUTHOR) =>
	resolveWire(mutations["post.saveDraft"], {
		input: {title: "yarım kalmış"},
		select: ["id", "title", "isDraft"],
	}).pipe(
		Effect.provide(Layer.mergeAll(pano, liveStub)),
		Effect.provideService(CurrentUser, {user}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
	);

describe("pano draft-save", () => {
	it.effect("Pano.saveDraft runs and the returned Post carries isDraft: true", () =>
		Effect.gen(function* () {
			const post = yield* saveDraft(panoStub(() => Effect.succeed(draftRow)));
			assert.strictEqual((post as {isDraft?: boolean}).isDraft, true);
			assert.strictEqual((post as {id?: string}).id, "post_draft1");
		}),
	);
});
