/**
 * The author's own-posts read, the private complement of the draft-masked public reads.
 * The load-bearing case is that a DRAFT is INCLUDED — this surface applies no published
 * mask. Author-scoping is the SQL `where author_id = ?`, so a foreign row never reaches
 * this JS.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import type * as schema from "../../db/drizzle/schema.ts";
import {Mecmua, MecmuaLive} from "./Mecmua.ts";

type MecmuaRecord = typeof schema.mecmuaPost.$inferSelect;

const post = (over: Partial<MecmuaRecord> & {id: string}): MecmuaRecord => ({
	slug: null,
	title: `başlık ${over.id}`,
	body: "gövde",
	authorId: "A",
	publishedAt: null,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	...over,
});

const scriptedAccess = (results: ReadonlyArray<unknown>): DrizzleAccess => {
	const state = {i: 0};
	return {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			void fn;
			return Effect.succeed(results[state.i++] as A);
		},
		batch: () => Effect.die(new Error("mecmua own-posts reads use run(), never batch()")),
	};
};

const mecmuaLayer = (access: DrizzleAccess) =>
	MecmuaLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

describe("Mecmua.listOwnPostsConnection — the author's own drafts + published", () => {
	// A published post AND a draft, as the `author_id = ?` fetch would return them.
	const ownRows: MecmuaRecord[] = [
		post({
			id: "a-2",
			authorId: "A",
			createdAt: new Date("2026-03-01T00:00:00.000Z"),
			publishedAt: null,
		}),
		post({
			id: "a-1",
			authorId: "A",
			createdAt: new Date("2026-02-01T00:00:00.000Z"),
			publishedAt: new Date("2026-02-05T00:00:00.000Z"),
		}),
	];

	it.effect("INCLUDES a draft (null publishedAt) alongside published — no mask applied", () =>
		Effect.gen(function* () {
			const mecmua = yield* Mecmua;
			const page = yield* mecmua.listOwnPostsConnection({authorId: "A"});
			assert.deepStrictEqual(
				page.rows.map((r) => r.id),
				["a-2", "a-1"],
			);
			assert.isTrue(page.rows.some((r) => r.publishedAt === null));
		}).pipe(Effect.provide(mecmuaLayer(scriptedAccess([ownRows])))),
	);

	it.effect("an author with no posts gets an empty page", () =>
		Effect.gen(function* () {
			const mecmua = yield* Mecmua;
			const page = yield* mecmua.listOwnPostsConnection({authorId: "A"});
			assert.deepStrictEqual(page.rows, []);
			assert.isFalse(page.hasNextPage);
		}).pipe(Effect.provide(mecmuaLayer(scriptedAccess([[]])))),
	);
});
