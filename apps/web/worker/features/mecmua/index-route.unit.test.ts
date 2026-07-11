/**
 * The mecmua public-index draft-mask + ordering (#2512, epic #2467). The public index
 * must (a) route the draft decision through the one `MecmuaPostVisibility` seam
 * (`mecmuaPostVisibleWhere`) so an anonymous visitor never sees an unpublished post, and
 * (b) order newest-first by `published_at`. Both are offline-reachable off `.toSQL()`
 * (no query runs) plus a scripted-`run` mapping check.
 */
import {assert, describe, it} from "@effect/vitest";
import {desc} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {Effect} from "effect";
import {type DrizzleAccessOrDie, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {
	listPublishedMecmuaPosts,
	type MecmuaIndexRow,
	mecmuaPublishedIndexWhere,
} from "./index-route.ts";

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

/** A `run` that ignores its query and resolves the scripted rows — the mapping fixtures never touch D1. */
const scriptedRun =
	(rows: ReadonlyArray<unknown>): DrizzleAccessOrDie["run"] =>
	<A>(_fn: (db: DrizzleDb) => Promise<A>) =>
		Effect.succeed(rows as A);

const now = new Date("2026-07-11T00:00:00.000Z");

describe("the public index masks drafts + orders newest-first (#2512)", () => {
	it("gates on published_at with NO ownership escape and orders by published_at DESC", () => {
		const {sql} = renderDb
			.select({
				id: schema.mecmuaPost.id,
				slug: schema.mecmuaPost.slug,
				title: schema.mecmuaPost.title,
				publishedAt: schema.mecmuaPost.publishedAt,
			})
			.from(schema.mecmuaPost)
			.where(mecmuaPublishedIndexWhere)
			.orderBy(desc(schema.mecmuaPost.publishedAt))
			.toSQL();
		assert.match(
			sql,
			/"mecmua_post"\."published_at" is not null/,
			"the published gate masks a null-published draft from the public index",
		);
		assert.notMatch(
			sql,
			/"mecmua_post"\."author_id" = \?/,
			"an anonymous index read has no author-ownership disjunction — a draft never appears",
		);
		assert.match(
			sql,
			/order by "mecmua_post"\."published_at" desc/,
			"the index is chronological, newest published first",
		);
	});

	it.effect(
		"maps scripted published rows onto lean wire rows (id + slug + title + publishedAt)",
		() =>
			Effect.gen(function* () {
				const rows = [
					{id: "mecmua_2", slug: "ikinci", title: "ikinci yazı", publishedAt: now},
					{id: "mecmua_1", slug: "birinci", title: "birinci yazı", publishedAt: now},
				];
				const got: ReadonlyArray<MecmuaIndexRow> = yield* listPublishedMecmuaPosts(
					scriptedRun(rows),
				);
				assert.strictEqual(got.length, 2);
				assert.strictEqual(got[0]?.id, "mecmua_2");
				assert.strictEqual(got[0]?.title, "ikinci yazı");
				assert.strictEqual(got[1]?.slug, "birinci");
			}),
	);
});
