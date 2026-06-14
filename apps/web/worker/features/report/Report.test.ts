/**
 * Report service tests over the `node:sqlite`-backed D1 fake — the REAL `Report`
 * methods against an actual SQL engine with the committed migrations applied
 * (the `Vote.test.ts` precedent). T1 per `.patterns/effect-testing.md`.
 */
import {assert, describe, it} from "@effect/vitest";
import {and, eq} from "drizzle-orm";
import {Effect, Exit, Layer} from "effect";
import {createDrizzle, Drizzle, makeDrizzleAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {makeSqliteTestDb, type SqliteD1} from "../../db/sqlite-d1.testing.ts";
import {Report, ReportLive} from "./Report.ts";

function freshDb(): {sqlite: SqliteD1; layer: Layer.Layer<Report | Drizzle>} {
	const sqlite = makeSqliteTestDb();
	const db = createDrizzle(sqlite.d1);
	const DrizzleLayer = Layer.succeed(Drizzle, makeDrizzleAccess(db));
	const layer = ReportLive.pipe(Layer.provideMerge(DrizzleLayer));
	return {sqlite, layer};
}

const now = new Date();

// A reportable definition so `assertTargetLive` finds a live row.
const seedDefinition = (id: string, deletedAt: Date | null = null) =>
	Effect.gen(function* () {
		const {run} = yield* Drizzle;
		yield* run((d) =>
			d
				.insert(schema.definitionView)
				.values({
					id,
					authorId: "author-1",
					authorName: "umut",
					termSlug: "slug-1",
					termTitle: "Slug",
					body: "body",
					bodyExcerpt: "body",
					score: 0,
					createdAt: now,
					updatedAt: now,
					deletedAt,
					lastEventId: "",
				})
				.run(),
		);
	});

describe("Report.submit", () => {
	it.effect("a first report inserts exactly one row", () => {
		const {sqlite, layer} = freshDb();
		return Effect.gen(function* () {
			yield* seedDefinition("def-1");
			const report = yield* Report;

			const result = yield* report.submit({
				reporterId: "reporter-1",
				targetKind: "definition",
				targetId: "def-1",
				reason: "spam",
			});
			assert.isTrue(result.created, "first report is created");

			const {run} = yield* Drizzle;
			const rows = yield* run((d) =>
				d.select().from(schema.contentReport).where(eq(schema.contentReport.targetId, "def-1")),
			);
			assert.strictEqual(rows.length, 1, "exactly one row");
			assert.strictEqual(rows[0]!.reporterId, "reporter-1");
			assert.strictEqual(rows[0]!.status, "open", "born open");
			assert.strictEqual(rows[0]!.reason, "spam");
			sqlite.close();
		}).pipe(Effect.provide(layer));
	});

	it.effect("a duplicate (reporter, kind, id) is an idempotent no-op success", () => {
		const {sqlite, layer} = freshDb();
		return Effect.gen(function* () {
			yield* seedDefinition("def-1");
			const report = yield* Report;

			const first = yield* report.submit({
				reporterId: "reporter-1",
				targetKind: "definition",
				targetId: "def-1",
			});
			assert.isTrue(first.created);

			const second = yield* report.submit({
				reporterId: "reporter-1",
				targetKind: "definition",
				targetId: "def-1",
				reason: "different reason ignored",
			});
			assert.isFalse(second.created, "re-report is a no-op (created=false)");

			const {run} = yield* Drizzle;
			const rows = yield* run((d) =>
				d
					.select()
					.from(schema.contentReport)
					.where(
						and(
							eq(schema.contentReport.reporterId, "reporter-1"),
							eq(schema.contentReport.targetKind, "definition"),
							eq(schema.contentReport.targetId, "def-1"),
						),
					),
			);
			assert.strictEqual(rows.length, 1, "still exactly one row after re-report");
			assert.strictEqual(rows[0]!.reason, null, "the first (no-reason) row is untouched");
			sqlite.close();
		}).pipe(Effect.provide(layer));
	});

	it.effect("a missing target raises ReportTargetNotFound (not an infra error)", () => {
		const {sqlite, layer} = freshDb();
		return Effect.gen(function* () {
			const report = yield* Report;
			const exit = yield* Effect.exit(
				report.submit({reporterId: "reporter-1", targetKind: "post", targetId: "ghost"}),
			);
			assert.isTrue(Exit.isFailure(exit), "submit against a missing target fails");
			const failure = Exit.isFailure(exit) ? exit.cause : null;
			assert.match(String(failure), /ReportTargetNotFound/, "fails with the domain not-found");
			sqlite.close();
		}).pipe(Effect.provide(layer));
	});

	it.effect("a soft-deleted target raises ReportTargetNotFound", () => {
		const {sqlite, layer} = freshDb();
		return Effect.gen(function* () {
			yield* seedDefinition("def-gone", now);
			const report = yield* Report;
			const exit = yield* Effect.exit(
				report.submit({reporterId: "reporter-1", targetKind: "definition", targetId: "def-gone"}),
			);
			assert.isTrue(Exit.isFailure(exit), "submit against a soft-deleted target fails");
			assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /ReportTargetNotFound/);
			sqlite.close();
		}).pipe(Effect.provide(layer));
	});
});

describe("Report.readMine", () => {
	it.effect("returns exactly the matching ids for a viewer + kind", () => {
		const {sqlite, layer} = freshDb();
		return Effect.gen(function* () {
			const {run} = yield* Drizzle;
			yield* run((d) =>
				d
					.insert(schema.contentReport)
					.values([
						{
							id: "r1",
							reporterId: "u1",
							targetKind: "definition",
							targetId: "def-1",
							reason: null,
							status: "open",
							createdAt: now,
						},
						{
							id: "r2",
							reporterId: "u1",
							targetKind: "post",
							targetId: "def-2",
							reason: null,
							status: "open",
							createdAt: now,
						},
						{
							id: "r3",
							reporterId: "u2",
							targetKind: "definition",
							targetId: "def-3",
							reason: null,
							status: "open",
							createdAt: now,
						},
					])
					.run(),
			);

			const report = yield* Report;
			const reported = yield* report.readMine("u1", "definition", ["def-1", "def-2", "def-3"]);
			assert.deepStrictEqual([...reported].sort(), ["def-1"]);
			sqlite.close();
		}).pipe(Effect.provide(layer));
	});

	it.effect("empty ids → empty Set", () => {
		const {sqlite, layer} = freshDb();
		return Effect.gen(function* () {
			const report = yield* Report;
			const reported = yield* report.readMine("u1", "definition", []);
			assert.strictEqual(reported.size, 0);
			sqlite.close();
		}).pipe(Effect.provide(layer));
	});

	it.effect("null viewer → empty Set", () => {
		const {sqlite, layer} = freshDb();
		return Effect.gen(function* () {
			const report = yield* Report;
			const reported = yield* report.readMine(null, "definition", ["def-1"]);
			assert.strictEqual(reported.size, 0);
			sqlite.close();
		}).pipe(Effect.provide(layer));
	});
});
