/**
 * `Post`'s one column→field map. The row mappers, the wire shaper and the view
 * field declaration all derive from it, so a one-field change lands here instead of
 * in three hand-synced restatements (#1166).
 *
 * Two things to know: the detail page reads the canonical `body` while the feed
 * summary reads `bodyExcerpt` (the `bodySource` knob), and the viewer scalars
 * (`myVote` / `isSaved`) are stamped downstream from batched reads, never read from
 * the record here.
 */

import {tagLabel} from "../../../src/lib/panoTags.ts";
import type * as schema from "../../db/drizzle/schema.ts";
import type {ReactionAggregate} from "../reaction/Reaction.ts";

type PostRecord = typeof schema.postRecord.$inferSelect;

export interface PostTagRow {
	kind: string;
	label: string;
}

/** Empty body collapses to `null` so every path yields the same wire shape. */
const normalizeBody = (raw: string | null): string | null => (raw && raw.length > 0 ? raw : null);

export const parseTags = (csv: string): PostTagRow[] => {
	if (!csv) return [];
	return csv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((kind) => ({kind, label: tagLabel(kind)}));
};

// The keys ARE the wire field names, so the readers absorb the `authorName`→`author`
// rename, the null-timestamp fallback, the CSV parse and the body-source split.
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

// `updatedAt` and `isDraft` are optional because the keyset and search projections
// select a column subset that omits them; the by-id read supplies both.
export interface PostSummaryRow extends Omit<IntrinsicRow, "updatedAt" | "isDraft"> {
	updatedAt?: Date;
	isDraft?: boolean | null;
	myVote?: boolean | null;
	isSaved?: boolean | null;
	// Owner-scoped in-review flag (#2200): true only when the viewer is the author, so
	// it never leaks review state to anyone else. Unstamped reads leave it `undefined`
	// and the shaper defaults it false.
	sandboxed?: boolean;
	/**
	 * The reader-facing çaylak marker (#6425): `true` iff this post is still sandboxed
	 * AND the viewer is the opted-in in-place reader of #6423, stamped by the read paths
	 * via `sandboxedInPlace` off the resolved `SandboxViewer`.
	 *
	 * The twin of `sandboxed` above, and never a substitute for it. `sandboxed` is
	 * owner-scoped — the AUTHOR's "incelemede" signal about their OWN post, rendered as
	 * `ReviewBadge`. This one marks SOMEBODY ELSE's hazırlık-stage post for a reader who
	 * asked to see çaylak work in place. Disjoint audiences on the same row, so they
	 * cannot collapse into one field. A read that doesn't stamp it leaves it `undefined`
	 * → the shaper defaults `false`, which is also what every viewer gets while
	 * `PHOENIX_CAYLAK_VISIBILITY` is off.
	 */
	sandboxedInPlace?: boolean;
	/**
	 * The author's LIVE handle (`user_profile.username` / `.displayName`), stamped by
	 * `stampAuthorIdentity` after the batched `getProfileIdentitiesByIds` read (#2139)
	 * so the client renders the CURRENT display name via `actorLabel`, not the write-time
	 * `authorName` snapshot (#2126's AC). `undefined` when not requested; `null` when the
	 * author has no profile/handle — `actorLabel` then degrades to `@username` → fallback.
	 */
	authorUsername?: string | null;
	authorDisplayName?: string | null;
	reactions?: ReactionAggregate;
}

export interface PostConnectionPage {
	rows: PostSummaryRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

export type PostPage = Omit<IntrinsicRow, "isDraft">;

// The wire shaper's input. Nullability is looser than the row's because a fresh
// write or vote carries no `updatedAt` and the late-stamped fields are not there yet.
export type PostFields = Omit<IntrinsicRow, "updatedAt" | "isDraft" | "tags"> & {
	updatedAt?: Date | null;
	isDraft?: boolean | null;
	myVote?: boolean | null;
	isSaved?: boolean | null;
	sandboxed?: boolean;
	sandboxedInPlace?: boolean;
	authorUsername?: string | null;
	authorDisplayName?: string | null;
	reactions?: ReactionAggregate;
	tags: ReadonlyArray<PostTagRow>;
};

// Must stay a static literal — fate's `FateDataView` reads the field map off it, so a
// dynamically-built object won't do. The `satisfies` is what keeps the view in lockstep
// with the row: dropping a field here, or adding one to `PostSummaryRow` without
// listing it, is a compile error.
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
	sandboxed: true,
	sandboxedInPlace: true,
	authorUsername: true,
	authorDisplayName: true,
	reactions: true,
} as const satisfies Record<keyof Omit<PostSummaryRow, "tags">, true>;

const fieldKeys = Object.keys(intrinsicFields) as Array<keyof typeof intrinsicFields>;

const toRow = (p: PostRecord, bodySource: BodySource): IntrinsicRow =>
	Object.fromEntries(fieldKeys.map((f) => [f, intrinsicFields[f](p, bodySource)])) as IntrinsicRow;

export const toPostPage = (p: PostRecord): PostPage => toRow(p, "body");

export const toPostSummaryRow = (p: PostRecord): PostSummaryRow => toRow(p, "bodyExcerpt");

// The keyset projection selects a column subset, yet its rows must agree with the
// by-id path field-for-field — an empty excerpt has to collapse to `null`, not `""`
// (#1170). So it runs through the same `intrinsicFields` map instead of hand-syncing
// its own body handling.
export type PostKeysetRow = Pick<
	PostRecord,
	| "id"
	| "slug"
	| "title"
	| "url"
	| "host"
	| "bodyExcerpt"
	| "authorId"
	| "authorName"
	| "score"
	| "commentCount"
	| "createdAt"
	| "tags"
>;

export const toPostSummaryKeysetRow = (p: PostKeysetRow): PostSummaryRow =>
	toRow(p as PostRecord, "bodyExcerpt");
