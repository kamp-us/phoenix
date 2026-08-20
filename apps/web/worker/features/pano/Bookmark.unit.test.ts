/**
 * The Bookmark decisions that are wrong-or-right with no database (ADR 0082): a
 * `run`/`batch` that THROWS proves a short-circuit never touched the DB, and a stubbed
 * `run` feeds the decision its inputs without an engine.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import {Bookmark, BookmarkLive} from "./Bookmark.ts";

const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("Bookmark read the DB on a path that must short-circuit")),
	batch: () => Effect.die(new Error("Bookmark wrote a batch on a path that must short-circuit")),
};

// `run` replays a queued sequence; `batch` throws, so an idempotent no-op that reaches
// the write fails the test.
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
			const exit = yield* Effect.exit(
				bookmark.toggle({userId: "u1", postId: "ghost", value: true}),
			);
			assert.isTrue(exit._tag === "Failure", "toggle against a missing post fails");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /PostNotFound/);
		}).pipe(Effect.provide(bookmarkLayer(scriptedAccess([undefined]).access))),
	);

	it.effect("re-saving an already-saved post is an idempotent no-op — no batch", () => {
		// run #1 post probe → a live post row; run #2 presence probe → already saved.
		const {access} = scriptedAccess([{id: "p1"}, {postId: "p1"}]);
		return Effect.gen(function* () {
			const bookmark = yield* Bookmark;
			const result = yield* bookmark.toggle({userId: "u1", postId: "p1", value: true});
			assert.isFalse(result.changed, "matching state is a no-op");
			assert.isTrue(result.isSaved, "already-saved → isSaved true");
			assert.strictEqual(result.postId, "p1");
		}).pipe(Effect.provide(bookmarkLayer(access)));
	});

	it.effect("un-saving a never-saved post is an idempotent no-op — no batch", () => {
		// run #1 post probe → a live post row; run #2 presence probe → not saved.
		const {access} = scriptedAccess([{id: "p1"}, undefined]);
		return Effect.gen(function* () {
			const bookmark = yield* Bookmark;
			const result = yield* bookmark.toggle({userId: "u1", postId: "p1", value: false});
			assert.isFalse(result.changed, "matching state is a no-op");
			assert.isFalse(result.isSaved, "never-saved → isSaved false");
			assert.strictEqual(result.postId, "p1");
		}).pipe(Effect.provide(bookmarkLayer(access)));
	});
});
