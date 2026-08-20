/**
 * Pins that the by-id summary and the keyset/feed summary agree wire field for wire
 * field, so neither drifts to `""` where the other says `null` (#1170). `updatedAt` /
 * `isDraft` are excluded because the keyset projection omits those columns and they
 * legitimately fall back.
 */
import {assert, describe, it} from "@effect/vitest";
import type * as schema from "../../db/drizzle/schema.ts";
import {EMPTY_REACTION_AGGREGATE} from "../reaction/Reaction.ts";
import {type PostKeysetRow, toPostSummaryKeysetRow, toPostSummaryRow} from "./post-fields.ts";
import {toPost} from "./shapers.ts";

type PostRecord = typeof schema.postRecord.$inferSelect;

const baseRecord = (bodyExcerpt: string | null): PostRecord => ({
	id: "post-1",
	slug: "baslik",
	title: "başlık",
	url: "https://kamp.us",
	host: "kamp.us",
	body: "tam gövde",
	bodyExcerpt,
	authorId: "user-1",
	authorName: "umut",
	tags: "show,ask",
	score: 3,
	commentCount: 2,
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

// The exact column subset `listPostsConnection` selects, so both mappers read one row.
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

const KEYSET_WIRE_FIELDS = [
	"__typename",
	"id",
	"slug",
	"title",
	"url",
	"host",
	"body",
	"author",
	"authorId",
	"authorUsername",
	"authorDisplayName",
	"score",
	"commentCount",
	"createdAt",
	"myVote",
	"isSaved",
	"sandboxed",
	"sandboxedInPlace",
	"reactions",
	"tags",
] as const;

describe("Pano Post wire shaper — by-id and keyset summaries converge (#1161, generalizes #1170)", () => {
	it("every keyset-projected wire field agrees across both summary paths", () => {
		const record = baseRecord("ilk birkaç kelime…");

		const byId = toPost(toPostSummaryRow(record));
		const keyset = toPost(toPostSummaryKeysetRow(keysetRowOf(record)));

		for (const f of KEYSET_WIRE_FIELDS) {
			assert.deepStrictEqual(
				keyset[f as keyof typeof keyset],
				byId[f as keyof typeof byId],
				`wire field \`${f}\` must agree across the by-id and keyset paths`,
			);
		}
	});

	it("empty `bodyExcerpt` → both paths emit `body: null` through the shaper", () => {
		const record = baseRecord("");

		assert.strictEqual(toPost(toPostSummaryRow(record)).body, null);
		assert.strictEqual(toPost(toPostSummaryKeysetRow(keysetRowOf(record))).body, null);
	});

	it("null `bodyExcerpt` → both paths emit `body: null` through the shaper", () => {
		const record = baseRecord(null);

		assert.strictEqual(toPost(toPostSummaryRow(record)).body, null);
		assert.strictEqual(toPost(toPostSummaryKeysetRow(keysetRowOf(record))).body, null);
	});

	it("non-empty `bodyExcerpt` → rides the wire verbatim through the shaper", () => {
		const record = baseRecord("ilk birkaç kelime…");

		// The literal value, not just cross-path agreement — a mapper mangling the excerpt
		// identically on both paths would pass the agreement case.
		assert.strictEqual(toPost(toPostSummaryRow(record)).body, "ilk birkaç kelime…");
		assert.strictEqual(
			toPost(toPostSummaryKeysetRow(keysetRowOf(record))).body,
			"ilk birkaç kelime…",
		);
	});

	it("the shaper emits the canonical `{__typename, …}` shape with viewer-scalar defaults", () => {
		const wire = toPost(toPostSummaryRow(baseRecord("özet")));

		assert.deepStrictEqual(Object.keys(wire).sort(), [
			"__typename",
			"author",
			"authorDisplayName",
			"authorId",
			"authorUsername",
			"body",
			"commentCount",
			"createdAt",
			"host",
			"id",
			"isDraft",
			"isSaved",
			"myVote",
			"reactions",
			"sandboxed",
			"sandboxedInPlace",
			"score",
			"slug",
			"tags",
			"title",
			"updatedAt",
			"url",
		]);
		assert.strictEqual(wire.__typename, "Post");
		assert.strictEqual(wire.myVote, null);
		assert.strictEqual(wire.isSaved, null);
		assert.strictEqual(wire.isDraft, null);
		// The owner-scoped in-review flag is stamped only by the read path, so a bare
		// summary must default it `false` rather than leak review state.
		assert.strictEqual(wire.sandboxed, false);
		// The reader-facing çaylak marker (#6425) is stamped only by a read path that
		// resolved a `SandboxViewer`; a bare summary shape defaults it `false` too.
		assert.strictEqual(wire.sandboxedInPlace, false);
		// No reactions requested on a bare summary read → the empty aggregate.
		assert.deepStrictEqual(wire.reactions, EMPTY_REACTION_AGGREGATE);
	});
});
