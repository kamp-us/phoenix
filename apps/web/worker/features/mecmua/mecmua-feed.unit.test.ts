/**
 * The subscribed-author feed's two load-bearing ACs (newest-published-first, no drafts or
 * unsubscribed authors), proven with no DB (ADR 0082) on the served
 * `Mecmua.listFeedConnection` path, which runs `selectMecmuaFeed`. The pure decision keeps
 * only its keyset tie-break, which the served fixture never reaches.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import type * as schema from "../../db/drizzle/schema.ts";
import {UserId} from "../../lib/ids.ts";
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

// A + B are subscribed and publish; A also has a draft; C is NOT subscribed. The feed
// should be [b-may, a-mar].
const rows: MecmuaRecord[] = [
	post({id: "a-mar", authorId: "A", publishedAt: AT("2026-03-01T00:00:00.000Z")}),
	post({id: "b-may", authorId: "B", publishedAt: AT("2026-05-01T00:00:00.000Z")}),
	post({id: "a-draft", authorId: "A", publishedAt: null}),
	post({id: "c-apr", authorId: "C", publishedAt: AT("2026-04-01T00:00:00.000Z")}),
];

const toRow = (r: MecmuaRecord): MecmuaPostRow => ({...r});

describe("selectMecmuaFeed — the tie-break the served rows below do not reach", () => {
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

/** Replays a queued result sequence, so a script must match the method's read order. */
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

describe("Mecmua.isSubscribed — the subscribe-affordance state read (#2527)", () => {
	it.effect("returns true when a (subscriber, author) edge row exists", () =>
		Effect.gen(function* () {
			const mecmua = yield* Mecmua;
			assert.isTrue(yield* mecmua.isSubscribed(UserId.make("reader"), UserId.make("A")));
		}).pipe(Effect.provide(mecmuaLayer(scriptedAccess([[{authorId: "A"}]])))),
	);

	it.effect("returns false when no edge row matches", () =>
		Effect.gen(function* () {
			const mecmua = yield* Mecmua;
			assert.isFalse(yield* mecmua.isSubscribed(UserId.make("reader"), UserId.make("A")));
		}).pipe(Effect.provide(mecmuaLayer(scriptedAccess([[]])))),
	);
});
