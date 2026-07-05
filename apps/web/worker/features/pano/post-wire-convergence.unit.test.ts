/**
 * The Pano `Post` wire shaper (`toPost`) and its two summary sources both trace to
 * the one `post-fields.ts` column→field map (#1126 AC#1, the Pano parallel of the
 * Definition slice). This pins that at the wire-shaper seam: it generalizes #1170's
 * `body`-only convergence to the WHOLE `{__typename, …}` object.
 *
 * - The by-id summary (`toPostSummaryRow`) and the keyset/feed summary
 *   (`toPostSummaryKeysetRow`) feed `toPost` and must agree, wire field for wire
 *   field, on every column the keyset projection carries — never `""` on one and
 *   `null` on the other (the #1170 class), and never a renamed/dropped field once the
 *   shaper's `PostFields` input derives from the same map as the mappers.
 *   (`updatedAt` / `isDraft` are excluded: the keyset projection selects a column
 *   subset that omits them, so they legitimately fall back to `createdAt` / `null`.)
 * - The shaper emits the canonical wire shape: exactly the `Post` key set, with the
 *   `myVote` / `isSaved` / `isDraft` viewer-scalar defaults stamped to `null`.
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

// The wire fields the keyset projection's column subset can populate — every `Post`
// field except the ones the subset omits (`updatedAt` / `isDraft`).
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

		// Pin the literal value (not merely cross-path agreement): a mapper that
		// mangled a non-empty excerpt identically on both paths would pass the
		// field-agreement case yet must fail here.
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
			"score",
			"slug",
			"tags",
			"title",
			"updatedAt",
			"url",
		]);
		assert.strictEqual(wire.__typename, "Post");
		// No viewer scalars requested on a bare summary read → defaulted to `null`.
		assert.strictEqual(wire.myVote, null);
		assert.strictEqual(wire.isSaved, null);
		assert.strictEqual(wire.isDraft, null);
		// No reactions requested on a bare summary read → the empty aggregate.
		assert.deepStrictEqual(wire.reactions, EMPTY_REACTION_AGGREGATE);
	});
});
