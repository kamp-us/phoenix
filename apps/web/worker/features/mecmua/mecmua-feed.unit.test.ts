/**
 * Unit — the subscribed-author feed's two load-bearing ACs (#2500), proven with no DB
 * (ADR 0082): (a) the feed returns PUBLISHED posts from SUBSCRIBED authors ordered by
 * `publishedAt` newest-first, and (b) draft/unpublished posts NEVER appear. Both are
 * proven twice: on the pure `selectMecmuaFeed` decision (the DB-free spec) AND on the
 * served `Mecmua.listFeedConnection` path over a scripted `Drizzle` seam (the `Bookmark`
 * / `Mecmua.unit.test.ts` idiom), so the guarantee holds where the feed is served, not
 * only in a helper.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import type * as schema from "../../db/drizzle/schema.ts";
import {selectMecmuaFeed} from "./feed-selection.ts";
import {Mecmua, MecmuaLive} from "./Mecmua.ts";
import type {MecmuaPostRow} from "./post-fields.ts";

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

const AT = (iso: string) => new Date(iso);

// Author A (subscribed) + B (subscribed) publish; A also has a draft; C (NOT subscribed)
// publishes. The feed should be [B-May, A-Mar] — newest published first, drafts + C gone.
const rows: MecmuaRecord[] = [
	post({id: "a-mar", authorId: "A", publishedAt: AT("2026-03-01T00:00:00.000Z")}),
	post({id: "b-may", authorId: "B", publishedAt: AT("2026-05-01T00:00:00.000Z")}),
	post({id: "a-draft", authorId: "A", publishedAt: null}),
	post({id: "c-apr", authorId: "C", publishedAt: AT("2026-04-01T00:00:00.000Z")}),
];

const toRow = (r: MecmuaRecord): MecmuaPostRow => ({...r});

describe("selectMecmuaFeed — the pure feed decision (ordering + draft mask)", () => {
	const subscribed = new Set(["A", "B"]);

	it("orders subscribed-author PUBLISHED posts by publishedAt newest-first", () => {
		const feed = selectMecmuaFeed(rows.map(toRow), subscribed);
		assert.deepStrictEqual(
			feed.map((r) => r.id),
			["b-may", "a-mar"],
		);
	});

	it("NEVER includes a draft (null publishedAt), even from a subscribed author", () => {
		const feed = selectMecmuaFeed(rows.map(toRow), subscribed);
		assert.isFalse(feed.some((r) => r.id === "a-draft"));
		assert.isTrue(feed.every((r) => r.publishedAt !== null));
	});

	it("excludes a non-subscribed author's published post", () => {
		const feed = selectMecmuaFeed(rows.map(toRow), subscribed);
		assert.isFalse(feed.some((r) => r.id === "c-apr"));
	});

	it("breaks a publishedAt tie by descending id (stable keyset order)", () => {
		const tie = AT("2026-06-01T00:00:00.000Z");
		const feed = selectMecmuaFeed(
			[
				post({id: "x1", authorId: "A", publishedAt: tie}),
				post({id: "x2", authorId: "A", publishedAt: tie}),
			].map(toRow),
			new Set(["A"]),
		);
		assert.deepStrictEqual(
			feed.map((r) => r.id),
			["x2", "x1"],
		);
	});
});

/** A `Drizzle` whose `run` replays a queued result sequence; `batch` is unused here. */
const scriptedAccess = (results: ReadonlyArray<unknown>): DrizzleAccess => {
	const state = {i: 0};
	return {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			void fn;
			return Effect.succeed(results[state.i++] as A);
		},
		batch: () => Effect.die(new Error("mecmua feed reads use run(), never batch()")),
	};
};

const mecmuaLayer = (access: DrizzleAccess) =>
	MecmuaLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

describe("Mecmua.listFeedConnection — the served feed path", () => {
	// Call order of `run`: (1) subscribed author ids, (2) fetch candidate posts (no `after`).
	const subscribedRows = [{authorId: "A"}, {authorId: "B"}];

	it.effect("returns subscribed-author published posts ordered publishedAt newest-first", () =>
		Effect.gen(function* () {
			const mecmua = yield* Mecmua;
			const page = yield* mecmua.listFeedConnection({subscriberId: "reader"});
			assert.deepStrictEqual(
				page.rows.map((r) => r.id),
				["b-may", "a-mar"],
			);
		}).pipe(Effect.provide(mecmuaLayer(scriptedAccess([subscribedRows, rows])))),
	);

	it.effect("excludes drafts and non-subscribed authors from the served page", () =>
		Effect.gen(function* () {
			const mecmua = yield* Mecmua;
			const page = yield* mecmua.listFeedConnection({subscriberId: "reader"});
			assert.isFalse(page.rows.some((r) => r.id === "a-draft"));
			assert.isFalse(page.rows.some((r) => r.id === "c-apr"));
			assert.isTrue(page.rows.every((r) => r.publishedAt !== null));
		}).pipe(Effect.provide(mecmuaLayer(scriptedAccess([subscribedRows, rows])))),
	);

	it.effect("a reader with no subscriptions gets an empty page (no post read)", () =>
		Effect.gen(function* () {
			const mecmua = yield* Mecmua;
			const page = yield* mecmua.listFeedConnection({subscriberId: "loner"});
			assert.deepStrictEqual(page.rows, []);
			assert.isFalse(page.hasNextPage);
		}).pipe(Effect.provide(mecmuaLayer(scriptedAccess([[]])))),
	);
});
