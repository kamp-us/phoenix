/**
 * The mecmua public-read draft-mask gate (#2498, epic #2467). The anonymous read must
 * route the draft decision through the one `MecmuaPostVisibility` seam
 * (`mecmuaPostVisibleWhere`), so a visitor holding a draft's slug/id never reads an
 * unpublished post. Two tiers, both offline-reachable:
 *
 *   - the SQL PREDICATE (`mecmuaPublicReadWhere`) carries `published_at is not null`
 *     (the published gate) and NO `author_id = ?` ownership escape — so a draft is
 *     structurally undisclosable to the public, whichever key names it;
 *   - `readPublishedMecmuaPost` resolves null when no published row matches (a draft or
 *     a genuine miss), which the route renders as a 404 — the masked case.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect} from "effect";
import {type DrizzleAccessOrDie, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {MecmuaPostRow} from "./post-fields.ts";
import {mecmuaPublicReadWhere, readPublishedMecmuaPost} from "./public-read-route.ts";

// biome-ignore lint/plugin: a host D1 binding can't be structurally faked; only `.toSQL()` rendering touches this — no query runs.
const noopD1 = {
	prepare: () => ({
		bind() {
			return this;
		},
		async all() {
			return {results: []};
		},
		async first() {
			return null;
		},
		async run() {
			return {};
		},
		async raw() {
			return [];
		},
	}),
	async batch() {
		return [];
	},
} as unknown as D1Database;
const renderDb = drizzle(noopD1, {relations});

/** A `run` that ignores its query and resolves the scripted rows — the leak/mask fixtures never touch D1. */
const scriptedRun =
	(rows: ReadonlyArray<unknown>): DrizzleAccessOrDie["run"] =>
	<A>(_fn: (db: DrizzleDb) => Promise<A>) =>
		Effect.succeed(rows as A);

const now = new Date("2026-07-11T00:00:00.000Z");

describe("mecmuaPublicReadWhere — the anonymous read masks drafts (the visibility seam, #2498)", () => {
	it("gates on published_at with NO ownership escape (a draft never discloses publicly)", () => {
		const {sql, params} = renderDb
			.select()
			.from(schema.mecmuaPost)
			.where(mecmuaPublicReadWhere("some-slug"))
			.toSQL();
		assert.match(
			sql,
			/"mecmua_post"\."published_at" is not null/,
			"the published gate from mecmuaPostVisibleWhere masks a null-published draft",
		);
		assert.notMatch(
			sql,
			/"mecmua_post"\."author_id" = \?/,
			"an anonymous read has no author-ownership disjunction — a draft never discloses to the public",
		);
		assert.include(params, "some-slug", "the key is bound against slug OR id");
	});
});

describe("readPublishedMecmuaPost — masked/miss resolves null (the route's 404 path, #2498)", () => {
	it.effect("a draft (masked by the WHERE ⇒ no row) resolves null", () =>
		Effect.gen(function* () {
			// The published gate drops the draft in SQL, so the query returns no rows —
			// the read maps that to null, which the route renders as a 404.
			const got = yield* readPublishedMecmuaPost(scriptedRun([]), "draft-slug");
			assert.isNull(got, "a draft must not be publicly readable — masked to null (404)");
		}),
	);

	it.effect("a published post resolves to its wire row", () =>
		Effect.gen(function* () {
			const published = {
				id: "mecmua_pub1",
				slug: "yayinda",
				title: "yayınlanmış yazı",
				body: "**merhaba** dünya",
				authorId: "author-1",
				publishedAt: now,
				createdAt: now,
				updatedAt: now,
			} satisfies typeof schema.mecmuaPost.$inferSelect;
			const got: MecmuaPostRow | null = yield* readPublishedMecmuaPost(
				scriptedRun([published]),
				"yayinda",
			);
			assert.isNotNull(got);
			assert.strictEqual(got?.id, "mecmua_pub1");
			assert.strictEqual(got?.title, "yayınlanmış yazı");
			assert.strictEqual(got?.body, "**merhaba** dünya");
		}),
	);
});
