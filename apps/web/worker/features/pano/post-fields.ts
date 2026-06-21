/**
 * `Post`'s one column→field map — the single structure the row mappers
 * (`rowToPostPage` + the by-id summary projection in `Pano.ts`), the wire shaper
 * (`toPost` in `shapers.ts`), and the view field declaration (`PostView` in
 * `views.ts`) all derive from, so a one-field change touches this map instead of
 * three hand-synced restatements (#1166, the Pano half of #1126 AC#1).
 *
 * Post diverges more than `Definition`: it has two record sources — the detail
 * `PostPage` reads the canonical `body`, the feed summary reads `bodyExcerpt`
 * (the `bodySource` knob is the only field that varies). `myVote` / `isSaved` are
 * viewer scalars — part of the view/wire field set (`postViewFields`) but *not*
 * read from the record here: they are stamped by `stampViewerScalars` after the
 * batched `user_vote` / `post_bookmark` reads (#1159, `viewer-scalars.ts`).
 * `isDraft`, by contrast, IS a record column (the taslak marker), so it rides the
 * intrinsic map.
 */

import {tagLabel} from "../../../src/lib/panoTags.ts";
import type * as schema from "../../db/drizzle/schema.ts";

type PostRecord = typeof schema.postRecord.$inferSelect;

export interface PostTagRow {
	kind: string;
	label: string;
}

/** Empty body collapses to `null` so every path yields the same wire shape. */
const normalizeBody = (raw: string | null): string | null => (raw && raw.length > 0 ? raw : null);

/** Parse the comma-separated `post_record.tags` CSV into `{kind, label}` scalars. */
export const parseTags = (csv: string): PostTagRow[] => {
	if (!csv) return [];
	return csv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((kind) => ({kind, label: tagLabel(kind)}));
};

/**
 * The intrinsic (record-derived) wire fields, in `PostView` order, each mapping a
 * `post_record` row onto its wire value. The keys ARE the wire field names; the
 * readers absorb the `authorName`→`author` rename, the null-timestamp fallback,
 * the `tags` CSV parse, and the `body` vs `bodyExcerpt` source split (the one
 * divergence between the detail-page and feed-summary mappers, selected by
 * `bodySource`).
 */
const intrinsicFields = {
	id: (p) => p.id,
	slug: (p) => p.slug,
	title: (p) => p.title,
	url: (p) => p.url,
	host: (p) => p.host,
	body: (p, bodySource) => normalizeBody(bodySource === "bodyExcerpt" ? p.bodyExcerpt : p.body),
	author: (p) => p.authorName,
	authorId: (p) => p.authorId,
	score: (p) => p.score,
	commentCount: (p) => p.commentCount,
	createdAt: (p) => p.createdAt ?? new Date(0),
	updatedAt: (p) => p.updatedAt ?? p.createdAt ?? new Date(0),
	tags: (p) => parseTags(p.tags),
	isDraft: (p) => p.isDraft ?? null,
} satisfies Record<string, (p: PostRecord, bodySource: BodySource) => unknown>;

type BodySource = "body" | "bodyExcerpt";

type IntrinsicRow = {
	[K in keyof typeof intrinsicFields]: ReturnType<(typeof intrinsicFields)[K]>;
};

/**
 * `PostSummaryRow` — the feed/keyset row: the record-derived intrinsic fields
 * plus the `myVote` / `isSaved` viewer scalars that `stampViewerScalars` adds
 * downstream. `updatedAt` and `isDraft` are optional here: the keyset projection
 * (`listPostsKeyset`) and the search projection select a column subset that omits
 * them, while the by-id read (`toPostSummaryRow`) supplies both. The viewer
 * scalars are `undefined` when not requested — never read from the record.
 */
export interface PostSummaryRow extends Omit<IntrinsicRow, "updatedAt" | "isDraft"> {
	updatedAt?: Date;
	/** Draft (taslak) marker; stamped from `post_record.is_draft` (null = published). */
	isDraft?: boolean | null;
	/** Viewer's upvote presence (`true` voted); `undefined`/`null` when not requested or anonymous. */
	myVote?: boolean | null;
	/** Viewer's bookmark presence; `undefined` (unset) for reads that don't request it. */
	isSaved?: boolean | null;
}

export interface PostConnectionPage {
	rows: PostSummaryRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

/**
 * `PostPage` — the detail-page shape: the intrinsic fields read from the
 * canonical `body`, minus `isDraft` and the viewer scalars (a page read threads
 * `myVote` / `isSaved` in separately at the call site). `updatedAt` is required.
 */
export type PostPage = Omit<IntrinsicRow, "isDraft">;

/**
 * The view/wire field selection (`{id: true, …}`) — a static literal (fate's
 * `FateDataView` reads the literal field map off this, so it can't be a
 * dynamically-built object). `satisfies Record<keyof PostSummaryRow, true>` pins
 * the scalar fields to exactly the row's fields: dropping one here (or adding one
 * to `PostSummaryRow` without listing it) is a compile error, so the view stays
 * in lockstep with the row mapper. `tags` and `comments` are non-scalar (`tags`
 * is an embedded-scalar array, `comments` a list relation); the `Omit` over them
 * lets `views.ts` declare those two structurally while pinning the rest.
 */
export const postViewFields = {
	id: true,
	slug: true,
	title: true,
	url: true,
	host: true,
	body: true,
	author: true,
	authorId: true,
	score: true,
	commentCount: true,
	createdAt: true,
	updatedAt: true,
	myVote: true,
	isSaved: true,
	isDraft: true,
} as const satisfies Record<keyof Omit<PostSummaryRow, "tags">, true>;

const fieldKeys = Object.keys(intrinsicFields) as Array<keyof typeof intrinsicFields>;

const toRow = (p: PostRecord, bodySource: BodySource): IntrinsicRow =>
	Object.fromEntries(fieldKeys.map((f) => [f, intrinsicFields[f](p, bodySource)])) as IntrinsicRow;

/**
 * Map a `post_record` row onto the detail `PostPage` (canonical `body`) — the
 * single record→page mapping, shared by `getPost` and the delete-refresh.
 */
export const toPostPage = (p: PostRecord): PostPage => toRow(p, "body");

/**
 * Map a `post_record` row onto the feed `PostSummaryRow` (feed `bodyExcerpt`) —
 * the single record→summary mapping. `myVote` / `isSaved` are stamped by
 * `stampViewerScalars`, not here.
 */
export const toPostSummaryRow = (p: PostRecord): PostSummaryRow => toRow(p, "bodyExcerpt");
