/**
 * The write-then-re-read pano mutations carry the resolved `SandboxViewer` (#6424, epic #4306).
 *
 * `post.vote`, `post.retractVote`, `post.save` and `post.unsave` each commit a write, then
 * re-resolve the post through `Pano.getPostsByIds` — a read that masks on the sandbox
 * dimension — and answer `PostNotFound` when the row comes back masked. Handed a degraded
 * `{viewerId}`-only viewer, an opted-in yazar (or a moderator) saves or votes a still-sandboxed
 * çaylak post, the row lands, and the handler errors on a mutation that already committed;
 * the saved list then lists the post the client was told does not exist.
 *
 * Asserted the way `saved-posts-viewer.unit.test.ts` asserts its own re-hydrate: drive the real
 * resolver through `resolveWire` and capture the viewer `Pano` was handed, never the call site.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {makeNotificationStub} from "../bildirim/Notification.testing.ts";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {sandboxViewerLayer} from "../kunye/sandbox.testing.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {Mute} from "../mute/Mute.ts";
import {Bookmark} from "./Bookmark.ts";
import {mutations} from "./mutations.ts";
import {Pano, type PostSummaryRow} from "./Pano.ts";

const VIEWER = {id: "opted-in-yazar", email: "kaan@kamp.us", name: "kaan"};
const POST_ID = "post_sb1";
const OPTED_IN_AT = new Date("2026-08-19T00:00:00.000Z");

const runtimeContextStub: BaseRuntimeContext = {
	Type: "mutation-rehydrate-viewer",
	id: "mutation-rehydrate-viewer",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

// The çaylak's still-sandboxed post the widened viewer can reach: another author's row,
// so the `author_id = ?` arm never covers it — only the in-place or moderator axis does.
const sandboxedRow = (): PostSummaryRow => ({
	id: POST_ID,
	slug: "post-sb1",
	title: "başlık",
	url: null,
	host: null,
	body: "gövde",
	author: "çaylak",
	authorId: "u-caylak",
	authorUsername: "caylak",
	authorDisplayName: "Çaylak",
	score: 1,
	commentCount: 0,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
	tags: [],
	myVote: true,
	isSaved: true,
	isDraft: null,
});

const writeResult = {
	postId: POST_ID,
	title: "başlık",
	url: null,
	host: null,
	body: "gövde",
	authorId: "u-caylak",
	authorName: "çaylak",
	score: 1,
	hotScore: 1,
	commentCount: 0,
	tags: [],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	myVote: true,
	changed: false,
};

const noopLive = Layer.succeed(LivePublisher)(
	livePublisherFor({publish: () => Effect.void, waitUntil: () => {}}),
);

// biome-ignore lint/plugin: a service double — only the bookmark toggle is on this path.
const BookmarkStub = Layer.succeed(Bookmark, {
	toggle: () => Effect.void,
	readMine: () => Effect.succeed(new Set<string>()),
	listSavedConnection: () => Effect.die("listSavedConnection not exercised"),
} as unknown as typeof Bookmark.Service);

const notificationStub = makeNotificationStub({
	recordAggregate: () => Effect.succeed({aggregated: false}),
});

const noMutes = Layer.succeed(Mute, {
	set: () => Effect.die("Mute.set not exercised"),
	listMine: () => Effect.die("Mute.listMine not exercised"),
	readMutedIds: () => Effect.succeed(new Set<string>()),
});

type Axes = Parameters<typeof sandboxViewerLayer>[0];

const WIRE_INPUT = {input: {id: POST_ID}, select: ["id"]};

/** Every service the four handlers reach, with the by-ids re-read capturing its viewer. */
const contextFor = (axes: Axes, seen: (SandboxViewer | undefined)[]) =>
	Layer.mergeAll(
		// biome-ignore lint/plugin: a service double — the write is scripted and the by-ids re-read captures the viewer it was handed.
		Layer.succeed(Pano, {
			voteOnPost: () => Effect.succeed(writeResult),
			retractPostVote: () => Effect.succeed({...writeResult, myVote: false}),
			getPostsByIds: (_ids: ReadonlyArray<string>, opts?: {sandboxViewer?: SandboxViewer}) =>
				Effect.sync(() => {
					seen.push(opts?.sandboxViewer);
					return [sandboxedRow()];
				}),
		} as unknown as typeof Pano.Service),
		BookmarkStub,
		noopLive,
		notificationStub,
		noMutes,
		sandboxViewerLayer(axes),
		Layer.succeed(CurrentUser, {user: VIEWER}),
		Layer.succeed(RuntimeContext, runtimeContextStub),
	);

// Each op is named at its own call site rather than looked up from a union: the four
// carry different error unions, and a union-typed lookup erases the one thing `resolveWire`
// infers from.
const HANDLERS = [
	{
		name: "post.vote",
		run: (ctx: ReturnType<typeof contextFor>) =>
			resolveWire(mutations["post.vote"], WIRE_INPUT).pipe(Effect.provide(ctx)),
	},
	{
		name: "post.retractVote",
		run: (ctx: ReturnType<typeof contextFor>) =>
			resolveWire(mutations["post.retractVote"], WIRE_INPUT).pipe(Effect.provide(ctx)),
	},
	{
		name: "post.save",
		run: (ctx: ReturnType<typeof contextFor>) =>
			resolveWire(mutations["post.save"], WIRE_INPUT).pipe(Effect.provide(ctx)),
	},
	{
		name: "post.unsave",
		run: (ctx: ReturnType<typeof contextFor>) =>
			resolveWire(mutations["post.unsave"], WIRE_INPUT).pipe(Effect.provide(ctx)),
	},
] as const;

type Handler = (typeof HANDLERS)[number];

/** Run one handler under these viewer axes and return the viewer its re-read was handed. */
const viewerHandedToRehydrate = (
	handler: Handler,
	axes: Axes,
): Effect.Effect<SandboxViewer, unknown> =>
	Effect.gen(function* () {
		const seen: (SandboxViewer | undefined)[] = [];
		yield* handler.run(contextFor(axes, seen));
		const viewer = seen[0];
		assert.isDefined(viewer, `${handler.name} handed its re-read a resolved sandbox viewer`);
		return viewer;
	});

describe("the write-then-re-read pano mutations carry the resolved viewer (#6424)", () => {
	for (const handler of HANDLERS) {
		it.effect(`${handler.name} re-reads as an opted-in yazar, so the committed write returns`, () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(
					yield* viewerHandedToRehydrate(handler, {
						flagOn: true,
						tier: "yazar",
						preference: {optedIn: true, setAt: OPTED_IN_AT},
						viewerId: VIEWER.id,
						isModerator: false,
					}),
					{viewerId: VIEWER.id, canSeeSandboxed: false, seesSandboxedInPlace: true},
				);
			}),
		);

		it.effect(`${handler.name} re-reads exactly as it does today for a not-opted-in yazar`, () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(
					yield* viewerHandedToRehydrate(handler, {
						flagOn: true,
						tier: "yazar",
						preference: {optedIn: false},
						viewerId: VIEWER.id,
						isModerator: false,
					}),
					{viewerId: VIEWER.id, canSeeSandboxed: false, seesSandboxedInPlace: false},
				);
			}),
		);

		it.effect(`${handler.name} re-reads exactly as it does today with the flag off`, () =>
			Effect.gen(function* () {
				// The tier and opt-in stubs die on contact, so this also proves the flag
				// short-circuits before either store is read.
				assert.deepStrictEqual(
					yield* viewerHandedToRehydrate(handler, {
						flagOn: false,
						viewerId: VIEWER.id,
						isModerator: false,
					}),
					{viewerId: VIEWER.id, canSeeSandboxed: false, seesSandboxedInPlace: false},
				);
			}),
		);

		// The moderator axis does not ride the flag, so this shape's SQL moves with the flag
		// OFF — deliberately. Before this change the degraded viewer pinned `canSeeSandboxed`
		// to `false`, which is why a moderator saving a sandboxed post got `PostNotFound` on a
		// bookmark that had already landed. Asserted rather than left to inspection.
		it.effect(`${handler.name} re-reads with the real moderator probe, flag off included`, () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(
					yield* viewerHandedToRehydrate(handler, {
						flagOn: false,
						viewerId: VIEWER.id,
						isModerator: true,
					}),
					{viewerId: VIEWER.id, canSeeSandboxed: true, seesSandboxedInPlace: false},
				);
			}),
		);
	}
});
