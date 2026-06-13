/**
 * Vote service tests over the `node:sqlite`-backed D1 fake. Unlike
 * `Drizzle.test.ts` (the raw wrapper), these exercise the REAL `Vote` methods
 * against an actual SQL engine with the baseline migration applied.
 */
import {assert, describe, it} from "@effect/vitest";
import {and, eq, sql} from "drizzle-orm";
import {Effect, Exit, Layer} from "effect";
import {createDrizzle, Drizzle, makeDrizzleAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {makeSqliteTestDb, type SqliteD1} from "../../db/sqlite-d1.testing.ts";
import {KarmaBump, Vote, VoteLive} from "./Vote.ts";

// Test provision for Vote's `KarmaBump` contract, spelled locally so `vote/`
// imports nothing from `pasaport/` (boundary pinned in vote-boundary.unit.test.ts).
// The atomicity test below depends on this targeting `user_profile` — it renames
// the table away mid-test.
const KarmaBumpTest = Layer.succeed(KarmaBump, {
	statement: (db, userId, delta) =>
		db
			.update(schema.userProfile)
			.set({totalKarma: sql`${schema.userProfile.totalKarma} + ${delta}`})
			.where(eq(schema.userProfile.userId, userId)),
});

// Fresh in-memory D1 (baseline migration applied) plus a layer exposing both
// `Vote` and `Drizzle`, so tests seed/read through `Drizzle` while driving `Vote`.
function freshDb(): {sqlite: SqliteD1; layer: Layer.Layer<Vote | Drizzle>} {
	const sqlite = makeSqliteTestDb();
	const db = createDrizzle(sqlite.d1);
	const DrizzleLayer = Layer.succeed(Drizzle, makeDrizzleAccess(db));
	const layer = VoteLive.pipe(Layer.provide(KarmaBumpTest), Layer.provideMerge(DrizzleLayer));
	return {sqlite, layer};
}

describe("Vote.readMine", () => {
	const now = new Date();

	it.effect("returns exactly the matching ids for a viewer + kind", () => {
		const {sqlite, layer} = freshDb();
		return Effect.gen(function* () {
			const {run} = yield* Drizzle;
			// u1's post-vote on "def-2" is a same-id different-kind row, proving
			// the kind filter bites (it must not surface in the definition query).
			yield* run((d) =>
				d
					.insert(schema.userVote)
					.values([
						{userId: "u1", targetKind: "definition", targetId: "def-1", createdAt: now},
						{userId: "u1", targetKind: "definition", targetId: "def-3", createdAt: now},
						{userId: "u1", targetKind: "post", targetId: "def-2", createdAt: now},
						{userId: "u2", targetKind: "definition", targetId: "def-2", createdAt: now},
					])
					.run(),
			);

			const vote = yield* Vote;
			const voted = yield* vote.readMine("u1", "definition", ["def-1", "def-2", "def-3"]);

			assert.deepStrictEqual([...voted].sort(), ["def-1", "def-3"]);
			sqlite.close();
		}).pipe(Effect.provide(layer));
	});

	it.effect("empty ids → empty Set (no read)", () => {
		const {sqlite, layer} = freshDb();
		return Effect.gen(function* () {
			const vote = yield* Vote;
			const voted = yield* vote.readMine("u1", "definition", []);
			assert.strictEqual(voted.size, 0);
			sqlite.close();
		}).pipe(Effect.provide(layer));
	});

	it.effect("null viewer → empty Set (no read)", () => {
		const {sqlite, layer} = freshDb();
		return Effect.gen(function* () {
			const vote = yield* Vote;
			const voted = yield* vote.readMine(null, "definition", ["def-1"]);
			assert.strictEqual(voted.size, 0);
			sqlite.close();
		}).pipe(Effect.provide(layer));
	});
});

/**
 * `Vote.cast` end-to-end atomicity over the real SQL engine: a karma `UPDATE`
 * that fails mid-batch must roll back the WHOLE cast. The vote-specific
 * invariant `Drizzle.test.ts` only proves generically.
 */
describe("Vote.cast atomicity (real SQLite via the D1 fake)", () => {
	const now = new Date();

	it.effect("a failing karma bump rolls back the entire cast — no partial write", () => {
		const {sqlite, layer} = freshDb();

		return Effect.gen(function* () {
			const {run} = yield* Drizzle;

			// A votable definition, so loadMeta + the score-cache update find a row.
			yield* run((d) =>
				d
					.insert(schema.definitionView)
					.values({
						id: "def-1",
						authorId: "author-1",
						authorName: "umut",
						termSlug: "slug-1",
						termTitle: "Slug",
						body: "body",
						bodyExcerpt: "body",
						score: 0,
						createdAt: now,
						updatedAt: now,
						deletedAt: null,
						lastEventId: "",
					})
					.run(),
			);

			// Rename user_profile away so the karma UPDATE fails mid-batch. The vote
			// insert + score update + user_vote mirror precede it, so the assertions
			// below prove the WHOLE batch rolls back, not just the last statement.
			yield* run((d) => d.run(sql`ALTER TABLE user_profile RENAME TO user_profile_gone`));

			const vote = yield* Vote;
			const exit = yield* Effect.exit(
				vote.cast({userId: "voter-1", targetKind: "definition", targetId: "def-1", value: 1}),
			);
			assert.isTrue(Exit.isFailure(exit), "the cast with a broken karma table must fail");

			const voteRows = yield* run((d) =>
				d
					.select()
					.from(schema.definitionVote)
					.where(eq(schema.definitionVote.definitionId, "def-1")),
			);
			assert.strictEqual(voteRows.length, 0, "no definition_vote row after rollback");

			const mirrorRows = yield* run((d) =>
				d
					.select()
					.from(schema.userVote)
					.where(
						and(
							eq(schema.userVote.userId, "voter-1"),
							eq(schema.userVote.targetKind, "definition"),
							eq(schema.userVote.targetId, "def-1"),
						),
					),
			);
			assert.strictEqual(mirrorRows.length, 0, "no user_vote mirror after rollback");

			const defRow = yield* run((d) =>
				d.select().from(schema.definitionView).where(eq(schema.definitionView.id, "def-1")),
			);
			assert.strictEqual(defRow[0]!.score, 0, "cached score unchanged after rollback");

			sqlite.close();
		}).pipe(Effect.provide(layer));
	});
});
