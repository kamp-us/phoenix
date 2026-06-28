/**
 * Pano's two `Post` read paths must agree on the wire value of `body` (#1170).
 * The by-id path (`getPostsByIds` → `toPostSummaryRow`) and the keyset/feed path
 * (`listPostsConnection` → `toPostSummaryKeysetRow`) both derive from the one
 * `post-fields.ts` column→field map, so an empty `bodyExcerpt` collapses to
 * `null` on BOTH — never `""` on one and `null` on the other. This pins that
 * convergence at the mapper seam (ADR 0082: a wrong-or-right field decision with
 * no SQL engine → unit), the divergence the inline keyset projection used to
 * reintroduce by hand-mapping `body: r.bodyExcerpt`.
 */
import {assert, describe, it} from "@effect/vitest";
import type * as schema from "../../db/drizzle/schema.ts";
import {type PostKeysetRow, toPostSummaryKeysetRow, toPostSummaryRow} from "./post-fields.ts";

type PostRecord = typeof schema.postRecord.$inferSelect;

const baseRecord = (bodyExcerpt: string | null): PostRecord => ({
	id: "post-1",
	slug: null,
	title: "başlık",
	url: null,
	host: null,
	body: "",
	bodyExcerpt,
	authorId: "user-1",
	authorName: "umut",
	tags: "",
	score: 0,
	commentCount: 0,
	hotScore: 0,
	createdAt: new Date(1000),
	updatedAt: new Date(2000),
	lastActivityAt: new Date(2000),
	removedAt: null,
	removedBy: null,
	removedReason: null,
	sandboxedAt: null,
	isDraft: null,
});

// The keyset path selects exactly this column subset (the `listPostsConnection`
// fetch); project the same record onto it so both mappers read one source row.
const keysetRowOf = (r: PostRecord): PostKeysetRow => ({
	id: r.id,
	slug: r.slug,
	title: r.title,
	url: r.url,
	host: r.host,
	bodyExcerpt: r.bodyExcerpt,
	authorId: r.authorId,
	authorName: r.authorName,
	score: r.score,
	commentCount: r.commentCount,
	createdAt: r.createdAt,
	tags: r.tags,
});

describe("Pano Post `body` — by-id and keyset paths converge (#1170)", () => {
	it('empty `bodyExcerpt` → both paths emit `body: null` (not `""`)', () => {
		const record = baseRecord("");

		const byId = toPostSummaryRow(record);
		const keyset = toPostSummaryKeysetRow(keysetRowOf(record));

		assert.strictEqual(byId.body, null, "by-id path normalizes empty excerpt to null");
		assert.strictEqual(keyset.body, null, "keyset path normalizes empty excerpt to null");
		assert.strictEqual(
			keyset.body,
			byId.body,
			"both read paths agree on the empty-excerpt wire value",
		);
	});

	it("null `bodyExcerpt` → both paths emit `body: null`", () => {
		const record = baseRecord(null);

		assert.strictEqual(toPostSummaryRow(record).body, null);
		assert.strictEqual(toPostSummaryKeysetRow(keysetRowOf(record)).body, null);
	});

	it("non-empty `bodyExcerpt` → unchanged on both paths (only empty→null is corrected)", () => {
		const record = baseRecord("ilk birkaç kelime…");

		const byId = toPostSummaryRow(record);
		const keyset = toPostSummaryKeysetRow(keysetRowOf(record));

		assert.strictEqual(byId.body, "ilk birkaç kelime…");
		assert.strictEqual(
			keyset.body,
			"ilk birkaç kelime…",
			"non-empty excerpt rides the wire verbatim",
		);
		assert.strictEqual(keyset.body, byId.body);
	});
});
