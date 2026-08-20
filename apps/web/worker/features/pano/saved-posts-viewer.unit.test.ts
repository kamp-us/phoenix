/**
 * `savedPosts` threads the resolved `SandboxViewer` into its re-hydrate (#6424, epic #4306).
 *
 * The saved list is a two-step read: `Bookmark.listSavedConnection` returns the ids, then
 * `Pano.getPostsByIds` re-fetches the rows and the resolver drops any id that comes back
 * masked. So the mask the re-hydrate applies IS the saved list's mask. Hand it a degraded
 * `{viewerId}`-only viewer and an opted-in yazar's bookmarked çaylak post vanishes from
 * their saved list while still sitting in the feed they bookmarked it from — no error
 * anywhere, the two reads simply disagree.
 *
 * Asserted the way `search-not-widened.unit.test.ts` asserts its narrowing: drive the real
 * resolver and capture the viewer `Pano` was handed, rather than inspecting the call site.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {Effect, Layer} from "effect";
import {sandboxViewerLayer} from "../kunye/sandbox.testing.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {Bookmark} from "./Bookmark.ts";
import {lists} from "./lists.ts";
import {Pano} from "./Pano.ts";

const VIEWER = {id: "opted-in-yazar", email: "kaan@kamp.us", name: "kaan", image: null};
const OPTED_IN_AT = new Date("2026-08-19T00:00:00.000Z");

// biome-ignore lint/plugin: a service double — only the saved keyset is on this path.
const BookmarkStub = Layer.succeed(Bookmark, {
	toggle: () => Effect.die(new Error("a read must not toggle a bookmark")),
	readMine: () => Effect.succeed(new Set<string>()),
	listSavedConnection: () =>
		Effect.succeed({ids: ["post_sb1"], hasNextPage: false, endCursor: null}),
} as unknown as typeof Bookmark.Service);

/** Run `savedPosts` under these stubs and return the viewer the re-hydrate was handed. */
const viewerHandedToRehydrate = (
	axes: Omit<Parameters<typeof sandboxViewerLayer>[0], "viewerId">,
): Effect.Effect<SandboxViewer, unknown> =>
	Effect.gen(function* () {
		const seen: (SandboxViewer | undefined)[] = [];
		// biome-ignore lint/plugin: a service double — only the by-ids re-hydrate is on this path, and it captures the viewer it was handed.
		const PanoStub = Layer.succeed(Pano, {
			getPostsByIds: (_ids: ReadonlyArray<string>, opts?: {sandboxViewer?: SandboxViewer}) =>
				Effect.sync(() => {
					seen.push(opts?.sandboxViewer);
					return [];
				}),
		} as unknown as typeof Pano.Service);

		yield* lists.savedPosts
			.resolve({args: {}, select: []})
			.pipe(
				Effect.provide(PanoStub),
				Effect.provide(BookmarkStub),
				Effect.provideService(CurrentUser, {user: VIEWER}),
				Effect.provide(sandboxViewerLayer({...axes, viewerId: VIEWER.id})),
			);

		const viewer = seen[0];
		assert.isDefined(viewer, "`Pano.getPostsByIds` received a resolved sandbox viewer");
		return viewer;
	});

describe("savedPosts — the re-hydrate carries the resolved viewer (#6424)", () => {
	it.effect("an opted-in yazar's saved list re-hydrates with the widened viewer", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(
				yield* viewerHandedToRehydrate({
					flagOn: true,
					tier: "yazar",
					preference: {optedIn: true, setAt: OPTED_IN_AT},
					isModerator: false,
				}),
				{viewerId: VIEWER.id, canSeeSandboxed: false, seesSandboxedInPlace: true},
			);
		}),
	);

	it.effect("a not-opted-in yazar's saved list re-hydrates exactly as it does today", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(
				yield* viewerHandedToRehydrate({
					flagOn: true,
					tier: "yazar",
					preference: {optedIn: false},
					isModerator: false,
				}),
				{viewerId: VIEWER.id, canSeeSandboxed: false, seesSandboxedInPlace: false},
			);
		}),
	);

	it.effect("with the flag off the saved list re-hydrates exactly as it does today", () =>
		Effect.gen(function* () {
			// The stubs below the flag die on contact, so this also proves the opt-in
			// store is never read when the flag is off.
			assert.deepStrictEqual(yield* viewerHandedToRehydrate({flagOn: false, isModerator: false}), {
				viewerId: VIEWER.id,
				canSeeSandboxed: false,
				seesSandboxedInPlace: false,
			});
		}),
	);

	// The moderator axis does not ride the flag, so THIS shape's SQL moves with the flag
	// off: the degraded viewer used to pin `canSeeSandboxed` to `false`, which dropped a
	// moderator's own bookmarked sandboxed post out of their saved list. Resolving the
	// viewer restores the moderator exemption `sandboxVisibleWhere` already grants every
	// other pano read. Deliberate and asserted, so the one shape that moves is covered.
	it.effect("a moderator's saved list re-hydrates with the real moderator probe", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* viewerHandedToRehydrate({flagOn: false, isModerator: true}), {
				viewerId: VIEWER.id,
				canSeeSandboxed: true,
				seesSandboxedInPlace: false,
			});
		}),
	);
});
