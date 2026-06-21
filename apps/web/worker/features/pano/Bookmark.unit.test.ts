/**
 * Bookmark unit coverage — the decisions that are wrong-or-right with no database
 * (ADR 0082). The `Drizzle` seam is substituted
 * directly (`Vote.unit.test.ts` idiom): a `run`/`batch` that THROWS proves a
 * short-circuit never touched the DB, and a stubbed `run` feeds the decision its
 * inputs without an engine.
 *
 * Bookmark's real-D1 fidelity — composite-PK presence idempotency, the
 * toggle/readMine round-trip over real rows — lands at the integration tier once
 * `#128` wires the fate view field + toggle mutation this child intentionally
 * omits (there is no HTTP/fate surface yet to drive Bookmark black-box over).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import {Bookmark, BookmarkLive} from "./Bookmark.ts";

// A `Drizzle` whose every call throws — any path that actually reaches the DB
// seam fails the test. A guard that short-circuits before reading runs to
// completion against it, which is exactly the "no read" proof.
const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("Bookmark read the DB on a path that must short-circuit")),
	batch: () => Effect.die(new Error("Bookmark wrote a batch on a path that must short-circuit")),
};

// A `Drizzle` whose `run` replays a queued sequence of results and whose `batch`
// throws — used to drive `toggle`'s pre-write decision (post probe + presence
// probe) while proving the idempotent no-op never reaches `batch`.
function scriptedAccess(results: ReadonlyArray<unknown>): {access: DrizzleAccess; runs: number} {
	const state = {i: 0};
	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			void fn;
			const value = results[state.i++] as A;
			return Effect.succeed(value);
		},
		batch: () => Effect.die(new Error("idempotent no-op toggle must not reach the batch")),
	};
	return {
		access,
		get runs() {
			return state.i;
		},
	};
}

const bookmarkLayer = (access: DrizzleAccess) =>
	BookmarkLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

describe("Bookmark.readMine — no-read short-circuit (mocked Drizzle seam)", () => {
	it.effect("empty ids → empty Set without touching the DB", () =>
		Effect.gen(function* () {
			const bookmark = yield* Bookmark;
			const saved = yield* bookmark.readMine("u1", []);
			assert.strictEqual(saved.size, 0);
		}).pipe(Effect.provide(bookmarkLayer(throwingAccess))),
	);

	it.effect("null viewer → empty Set without touching the DB", () =>
		Effect.gen(function* () {
			const bookmark = yield* Bookmark;
			const saved = yield* bookmark.readMine(null, ["p1"]);
			assert.strictEqual(saved.size, 0);
		}).pipe(Effect.provide(bookmarkLayer(throwingAccess))),
	);

	it.effect("undefined viewer → empty Set without touching the DB", () =>
		Effect.gen(function* () {
			const bookmark = yield* Bookmark;
			const saved = yield* bookmark.readMine(undefined, ["p1"]);
			assert.strictEqual(saved.size, 0);
		}).pipe(Effect.provide(bookmarkLayer(throwingAccess))),
	);
});

describe("Bookmark.toggle — pre-write decisions (mocked Drizzle seam)", () => {
	it.effect("a missing/soft-deleted post raises PostNotFound before any write", () =>
		Effect.gen(function* () {
			const bookmark = yield* Bookmark;
			// the postRecord probe's findFirst resolves to `undefined` → not-found, no batch.
			const exit = yield* Effect.exit(
				bookmark.toggle({userId: "u1", postId: "ghost", saved: true}),
			);
			assert.isTrue(exit._tag === "Failure", "toggle against a missing post fails");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /PostNotFound/);
		}).pipe(Effect.provide(bookmarkLayer(scriptedAccess([undefined]).access))),
	);

	it.effect("re-saving an already-saved post is an idempotent no-op — no batch", () => {
		// run #1 post probe → a live post row; run #2 presence probe → already saved.
		// The `batch` stub throws, so reaching it fails the test.
		const {access} = scriptedAccess([{id: "p1"}, {postId: "p1"}]);
		return Effect.gen(function* () {
			const bookmark = yield* Bookmark;
			const result = yield* bookmark.toggle({userId: "u1", postId: "p1", saved: true});
			assert.isFalse(result.changed, "matching state is a no-op");
			assert.isTrue(result.saved, "already-saved → saved true");
			assert.strictEqual(result.postId, "p1");
		}).pipe(Effect.provide(bookmarkLayer(access)));
	});

	it.effect("un-saving a never-saved post is an idempotent no-op — no batch", () => {
		// run #1 post probe → a live post row; run #2 presence probe → not saved.
		const {access} = scriptedAccess([{id: "p1"}, undefined]);
		return Effect.gen(function* () {
			const bookmark = yield* Bookmark;
			const result = yield* bookmark.toggle({userId: "u1", postId: "p1", saved: false});
			assert.isFalse(result.changed, "matching state is a no-op");
			assert.isFalse(result.saved, "never-saved → saved false");
			assert.strictEqual(result.postId, "p1");
		}).pipe(Effect.provide(bookmarkLayer(access)));
	});
});
