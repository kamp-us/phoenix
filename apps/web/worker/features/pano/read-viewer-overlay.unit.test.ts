/**
 * `Pano.readViewerOverlay` — the per-viewer overlay read (#2322, epic #2316 leg B):
 * post ids in → `myVote`/`isSaved` out. Unit-reachable because the whole decision is
 * "batch the presence readers once and stamp `viewerId ? set.has(id) : null`" — no SQL
 * engine (ADR 0082 litmus: wrong-even-if-the-DB-behaved-perfectly → unit).
 *
 * The load-bearing AC is **no N+1**: each `ViewerScalarSpec` reader (`Vote.readMine` /
 * `Bookmark.readMine`) must be called EXACTLY ONCE for the whole id batch, never per
 * row. The doubles here record every call, so the test asserts the call count is 1 per
 * spec with the full id set — the batched-read contract, proven structurally. A throwing
 * `Drizzle` under `PanoLive` proves the overlay reads no `post_record` at all.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess} from "../../db/Drizzle.ts";
import {PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import {ReactionStub} from "../reaction/Reaction.testing.ts";
import {Vote} from "../vote/Vote.ts";
import {Bookmark} from "./Bookmark.ts";
import {Pano, PanoLive} from "./Pano.ts";

// A `Drizzle` whose every `run`/`batch` dies — the overlay must reach NEITHER, so a
// stray DB touch fails the test loudly (the no-`post_record`-read proof).
const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("readViewerOverlay must not read the DB")),
	batch: () => Effect.die(new Error("readViewerOverlay must not batch")),
};

interface VoteCall {
	viewerId: string | null | undefined;
	target: string;
	ids: string[];
}
interface BookmarkCall {
	viewerId: string | null | undefined;
	ids: string[];
}

/** Build `PanoLive` over recording Vote/Bookmark doubles + the throwing Drizzle. */
function overlayLayer(votedIds: string[], savedIds: string[]) {
	const voteCalls: VoteCall[] = [];
	const bookmarkCalls: BookmarkCall[] = [];

	// biome-ignore lint/plugin: a service double — only `readMine` is on the overlay path; the other Vote methods die if reached.
	const VoteRec = Layer.succeed(Vote, {
		cast: () => Effect.die(new Error("overlay must not cast")),
		readMine: (viewerId: string | null | undefined, target: string, ids: ReadonlyArray<string>) => {
			voteCalls.push({viewerId, target, ids: [...ids]});
			// The reader owns the anonymous short-circuit — no presence for a null viewer.
			return Effect.succeed(viewerId ? new Set(votedIds) : new Set<string>());
		},
		clearTarget: () => Effect.void,
	} as unknown as typeof Vote.Service);

	// biome-ignore lint/plugin: a service double — only `readMine` is on the overlay path.
	const BookmarkRec = Layer.succeed(Bookmark, {
		toggle: () => Effect.die(new Error("overlay must not toggle")),
		readMine: (viewerId: string | null | undefined, ids: ReadonlyArray<string>) => {
			bookmarkCalls.push({viewerId, ids: [...ids]});
			return Effect.succeed(viewerId ? new Set(savedIds) : new Set<string>());
		},
		listSavedConnection: () => Effect.die(new Error("not used")),
	} as unknown as typeof Bookmark.Service);

	const layer = PanoLive.pipe(
		Layer.provide(VoteRec),
		Layer.provide(BookmarkRec),
		Layer.provide(ReactionStub),
		Layer.provide(PasaportIdentityStub),
		Layer.provide(Layer.succeed(Drizzle, throwingAccess)),
	);
	return {layer, voteCalls, bookmarkCalls};
}

describe("Pano.readViewerOverlay — batched per-viewer scalars, no N+1 (#2322)", () => {
	it.effect(
		"returns myVote/isSaved per id and reads each presence spec ONCE for the whole batch",
		() => {
			const {layer, voteCalls, bookmarkCalls} = overlayLayer(["p1"], ["p2"]);
			return Effect.gen(function* () {
				const pano = yield* Pano;
				const overlay = yield* pano.readViewerOverlay(["p1", "p2", "p3"], {viewerId: "u1"});

				assert.deepStrictEqual(overlay, [
					{id: "p1", myVote: true, isSaved: false},
					{id: "p2", myVote: false, isSaved: true},
					{id: "p3", myVote: false, isSaved: false},
				]);

				// No N+1: ONE vote read + ONE bookmark read for the 3-id batch, each carrying
				// the full id set (never one read per row).
				assert.strictEqual(voteCalls.length, 1, "one batched user_vote read");
				assert.strictEqual(bookmarkCalls.length, 1, "one batched post_bookmark read");
				assert.deepStrictEqual(voteCalls[0], {
					viewerId: "u1",
					target: "post",
					ids: ["p1", "p2", "p3"],
				});
				assert.deepStrictEqual(bookmarkCalls[0], {viewerId: "u1", ids: ["p1", "p2", "p3"]});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("degrades every scalar to null for an anonymous viewer", () => {
		const {layer} = overlayLayer(["p1"], ["p2"]);
		return Effect.gen(function* () {
			const pano = yield* Pano;
			const overlay = yield* pano.readViewerOverlay(["p1", "p2"], {viewerId: null});
			assert.deepStrictEqual(overlay, [
				{id: "p1", myVote: null, isSaved: null},
				{id: "p2", myVote: null, isSaved: null},
			]);
		}).pipe(Effect.provide(layer));
	});

	it.effect("short-circuits an empty id batch with no presence read at all", () => {
		const {layer, voteCalls, bookmarkCalls} = overlayLayer([], []);
		return Effect.gen(function* () {
			const pano = yield* Pano;
			const overlay = yield* pano.readViewerOverlay([], {viewerId: "u1"});
			assert.deepStrictEqual(overlay, []);
			assert.strictEqual(voteCalls.length, 0);
			assert.strictEqual(bookmarkCalls.length, 0);
		}).pipe(Effect.provide(layer));
	});
});
