/**
 * Pano — D1-direct module.
 *
 * Every function in this file reads/writes `env.PHOENIX_DB` via drizzle.
 * There is no Durable Object boundary, no workflow `create`, no outbox /
 * projection step. The legacy `PanoPost` Agent DO has been removed.
 *
 * Surface (resolver-callable):
 *   - `submitPost(env, input)` — insert `post_summary` row + bump
 *     `pano_stats`. Tag list serialized comma-separated on
 *     `post_summary.tags`.
 *   - `editPost(env, input)` — ownership-checked title / body refresh on
 *     `post_summary`; recomputes `hot_score` against `now` so frequent
 *     edits don't accidentally re-rank.
 *   - `deletePost(env, input)` — ownership-checked; fully removes the
 *     `post_summary` row (matches the legacy `PostDeleted` semantics:
 *     posts disappear from the feed entirely, vs. soft-stamp for
 *     definitions). Also wipes `post_vote` for the post and `user_vote`
 *     mirror rows, decrements karma for retracted votes.
 *   - `voteOnPost(env, input)` / `retractPostVote(env, input)` — mutate
 *     `post_vote`, recompute `post_summary.score` + `hot_score`, mirror
 *     onto `user_vote`, bump karma on `user_profile`. Idempotent:
 *     duplicate cast or retract is a no-op.
 *   - `addComment(env, input)` — insert `comment_view` row (with full
 *     body + denormalized post title), bump `post_summary.commentCount`,
 *     recompute `pano_stats`. Supports nested replies via `parentId`.
 *   - `editComment(env, input)` — ownership-checked body refresh on
 *     `comment_view`.
 *   - `deleteComment(env, input)` — ownership-checked; reply-aware
 *     soft-delete (parent-with-replies → stay in tree as `[silindi]`;
 *     leaf → fully removed). Decrements `post_summary.commentCount`.
 *   - `voteOnComment(env, input)` / `retractCommentVote(env, input)` —
 *     mutate `comment_vote`, recompute `comment_view.score`, mirror onto
 *     `user_vote`, bump karma on the comment author's `user_profile`.
 *
 * Vote logic for posts AND comments now delegates to the shared
 * `vote/module.ts`. The pano-side wrappers (`applyVote` for
 * posts, `applyCommentVote` for comments) load the target row for the
 * resolver-facing shape, dispatch to `vote()` with the right
 * `targetKind`, then re-read the score cache for the response.
 * `VoteTargetNotFoundError` is translated to `PostNotFoundError` /
 * `CommentNotFoundError` so the existing resolver error codec keeps
 * producing the same `extensions.code` values.
 *
 * Errors thrown by this module flow through the GraphQL `resolver()`
 * wrapper (see `worker/graphql/resolver.ts`) which routes them through
 * `encodeMutationError` for the wire-format `extensions.code`.
 */
import {id} from "@usirin/forge";
import {and, asc, eq, isNull, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "../../db/drizzle/schema";
import {vote, VoteTargetNotFoundError} from "../vote/module";

/* -------------------------------------------------------------------------- */
/* Domain types + errors                                                       */
/* -------------------------------------------------------------------------- */

/** Title cap (per PRD: ≤ 200 chars). */
export const POST_TITLE_MAX = 200;
/** Body cap (per PRD: ≤ 10 000 chars on submit / edit). */
export const POST_BODY_MAX = 10_000;
/**
 * Fixed tag enum for Pano posts (per PRD). The producer-side check is
 * defense-in-depth: the GraphQL resolver enforces the same set, but the
 * module is the durability boundary, so it re-validates.
 *
 * Stored on `post_summary.tags` as comma-separated values; rendered in
 * Turkish via `postSummaryReader`'s `TAG_LABELS`.
 */
export const ALLOWED_POST_TAG_KINDS = ["göster", "tartışma", "soru", "söylenme", "meta"] as const;

export type AllowedPostTagKind = (typeof ALLOWED_POST_TAG_KINDS)[number];

const EXCERPT_LEN = 280;

function excerpt(body: string): string {
	const flat = body.replace(/\s+/g, " ").trim();
	if (flat.length <= EXCERPT_LEN) return flat;
	return `${flat.slice(0, EXCERPT_LEN - 1).trimEnd()}…`;
}

/**
 * HN-style hot score: `score / (hours_old + 2)^1.8`. Multiplied by 1000
 * and floored so the persisted column stays an integer (D1 indexes
 * integers cheaper than floats and the relative ordering is what
 * matters). Mirrors the legacy `PanoPost.computeHotScore`.
 */
function computeHotScore(score: number, createdAtMs: number, nowMs: number): number {
	const hoursOld = Math.max(0, (nowMs - createdAtMs) / 3_600_000);
	const denom = (hoursOld + 2) ** 1.8;
	return Math.floor((score * 1000) / denom);
}

/**
 * Validation error thrown by `submitPost` / `editPost`. The GraphQL
 * resolver catches this via `encodeMutationError` and surfaces a stable
 * `extensions.code` so the SPA can localize without parsing free-text
 * messages.
 */
export class PostValidationError extends Error {
	constructor(
		readonly code:
			| "title_required"
			| "title_too_long"
			| "url_invalid"
			| "body_too_long"
			| "tags_required"
			| "tag_invalid",
		message: string,
	) {
		super(message);
		this.name = "PostValidationError";
	}
}

/**
 * Raised by every post mutation that targets a missing post (no
 * `post_summary` row, or the row has been deleted). The resolver
 * translates this to `extensions.code = POST_NOT_FOUND`.
 */
export class PostNotFoundError extends Error {
	readonly code = "post_not_found" as const;
	constructor(postId: string) {
		super(`post ${postId} not found`);
		this.name = "PostNotFoundError";
	}
}

/**
 * Raised by `editPost` / `deletePost` when the calling user is not the
 * row's author. The resolver translates this to a clean `UNAUTHORIZED`
 * extension code.
 */
export class UnauthorizedPostMutationError extends Error {
	readonly code = "unauthorized" as const;
	constructor(postId: string) {
		super(`not authorized to mutate post ${postId}`);
		this.name = "UnauthorizedPostMutationError";
	}
}

/* -------------------------------------------------------------------------- */
/* Read shapes (mirror PanoPost types pre-d1-direct)                            */
/* -------------------------------------------------------------------------- */

export interface PostTagRow {
	kind: string;
	label: string;
}

export interface PostPage {
	id: string;
	slug: string | null;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	author: string;
	/**
	 * Pasaport user id of the author. Powers the frontend's "is the
	 * current user the author?" check that gates edit / delete affordances.
	 */
	authorId: string;
	score: number;
	commentCount: number;
	createdAt: Date;
	/**
	 * Last-mutation timestamp; used by the SPA's "düzenlendi" indicator
	 * when `updatedAt > createdAt + 60s`.
	 */
	updatedAt: Date;
	tags: PostTagRow[];
}

/* -------------------------------------------------------------------------- */
/* Mutation result shapes                                                      */
/* -------------------------------------------------------------------------- */

export interface SubmitPostInput {
	title: string;
	url?: string | undefined;
	body?: string | undefined;
	tags: ReadonlyArray<{kind: string; label?: string | undefined}>;
	authorId: string;
	authorName: string;
}

export interface SubmitPostResult {
	postId: string;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	authorId: string;
	authorName: string;
	score: number;
	commentCount: number;
	tags: PostTagRow[];
	createdAt: Date;
}

export interface VoteOnPostInput {
	postId: string;
	voterId: string;
}

export interface VoteOnPostResult {
	postId: string;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	authorId: string;
	authorName: string;
	score: number;
	hotScore: number;
	commentCount: number;
	tags: PostTagRow[];
	createdAt: Date;
	/** `1` if the voter has voted on this post (post-write), `null` otherwise. */
	myVote: number | null;
	/** `true` if the vote row state changed; `false` on idempotent no-op. */
	changed: boolean;
}

export interface EditPostInput {
	postId: string;
	actorId: string;
	title?: string | undefined;
	body?: string | undefined;
}

export interface EditPostResult {
	postId: string;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	authorId: string;
	authorName: string;
	score: number;
	hotScore: number;
	commentCount: number;
	tags: PostTagRow[];
	createdAt: Date;
	updatedAt: Date;
}

export interface DeletePostInput {
	postId: string;
	actorId: string;
}

export interface DeletePostResult {
	postId: string;
	/** `true` if the row was deleted; `false` on idempotent no-op. */
	deleted: boolean;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Read a single post by id. Returns `null` when the row doesn't exist
 * (or has been deleted — under D1-direct, `deletePost` fully removes the
 * row, matching the legacy `PostDeleted` projection semantics).
 */
export async function getPost(env: Env, postId: string): Promise<PostPage | null> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const meta = await db.query.postSummary.findFirst({
		where: and(eq(schema.postSummary.id, postId), isNull(schema.postSummary.deletedAt)),
	});
	if (!meta) return null;
	return rowToPostPage(meta);
}

function rowToPostPage(row: typeof schema.postSummary.$inferSelect): PostPage {
	return {
		id: row.id,
		slug: row.slug,
		title: row.title,
		url: row.url,
		host: row.host,
		body: row.body && row.body.length > 0 ? row.body : null,
		author: row.authorName,
		authorId: row.authorId,
		score: row.score,
		commentCount: row.commentCount,
		createdAt: row.createdAt ?? new Date(0),
		updatedAt: row.updatedAt ?? row.createdAt ?? new Date(0),
		tags: parseTags(row.tags),
	};
}

const TAG_LABELS: Record<string, string> = {
	"göster": "göster",
	"tartışma": "tartışma",
	"soru": "soru",
	"söylenme": "söylenme",
	"meta": "meta",
	// Legacy English aliases that may exist in seed data.
	show: "göster",
	discuss: "tartışma",
	ask: "soru",
	rant: "söylenme",
};

function parseTags(csv: string): PostTagRow[] {
	if (!csv) return [];
	return csv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((kind) => ({kind, label: TAG_LABELS[kind] ?? kind}));
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Submit a new post. Mints the post id internally (forge ULID, `post_`
 * prefix). Mirrors sozluk's `addDefinition` convention (id minted
 * inside the module). The resolver-side contract surfaces the new id on
 * the `Post.id` return.
 *
 * Validation (defense-in-depth — resolver enforces too):
 * - `title` non-empty after trim, ≤ 200 chars
 * - `url` (if provided) parses as a `URL`
 * - `body` ≤ 10 000 chars
 * - `tags` non-empty; every kind ∈ ALLOWED_POST_TAG_KINDS
 *
 * Writes (in dependency order):
 *   1. Insert `post_summary` row (full body + excerpt + author + tags).
 *   2. Bump `pano_stats` totals.
 *
 * Returns the id along with the materialized row so the resolver can
 * shape the `Post` GraphQL response without a follow-up read.
 */
export async function submitPost(
	env: Env,
	input: SubmitPostInput,
): Promise<SubmitPostResult> {
	// ----- validation --------------------------------------------------
	const title = (input.title ?? "").trim();
	if (title.length === 0) {
		throw new PostValidationError("title_required", "başlık boş olamaz");
	}
	if (title.length > POST_TITLE_MAX) {
		throw new PostValidationError(
			"title_too_long",
			`başlık en fazla ${POST_TITLE_MAX} karakter olabilir`,
		);
	}
	const rawBody = input.body ?? "";
	if (rawBody.length > POST_BODY_MAX) {
		throw new PostValidationError(
			"body_too_long",
			`metin en fazla ${POST_BODY_MAX} karakter olabilir`,
		);
	}
	const body = rawBody.length === 0 ? null : rawBody;

	let host: string | null = null;
	let urlNormalized: string | null = null;
	if (input.url != null && input.url.length > 0) {
		let parsed: URL;
		try {
			parsed = new URL(input.url);
		} catch {
			throw new PostValidationError("url_invalid", "URL geçersiz");
		}
		urlNormalized = parsed.toString();
		host = parsed.host;
	}

	if (!input.tags || input.tags.length === 0) {
		throw new PostValidationError("tags_required", "en az bir etiket seç");
	}
	const allowed = new Set<string>(ALLOWED_POST_TAG_KINDS);
	const normalizedTags: PostTagRow[] = [];
	const seenKinds = new Set<string>();
	for (const t of input.tags) {
		const kind = (t.kind ?? "").trim();
		if (!allowed.has(kind)) {
			throw new PostValidationError("tag_invalid", `geçersiz etiket: ${kind || "(boş)"}`);
		}
		if (seenKinds.has(kind)) continue;
		seenKinds.add(kind);
		normalizedTags.push({kind, label: t.label?.trim() || kind});
	}

	const db = drizzle(env.PHOENIX_DB, {schema});

	const postId = id("post");
	const now = new Date();
	const hotScore = computeHotScore(0, now.getTime(), now.getTime());
	const bodyExcerpt = body ? excerpt(body) : null;
	const tagsCsv = normalizedTags.map((t) => t.kind).join(",");

	await db.insert(schema.postSummary).values({
		id: postId,
		slug: null,
		title,
		url: urlNormalized,
		host,
		body: body ?? "",
		bodyExcerpt: bodyExcerpt ?? "",
		authorId: input.authorId,
		authorName: input.authorName,
		tags: tagsCsv,
		score: 0,
		commentCount: 0,
		hotScore,
		createdAt: now,
		updatedAt: now,
		lastActivityAt: now,
		deletedAt: null,
		lastEventId: "",
	});

	await recomputePanoStats(env, now);

	return {
		postId,
		title,
		url: urlNormalized,
		host,
		body,
		authorId: input.authorId,
		authorName: input.authorName,
		score: 0,
		commentCount: 0,
		tags: normalizedTags,
		createdAt: now,
	};
}

/**
 * Cast an up-vote on a post. Idempotent: a re-cast from the same voter
 * is a no-op (composite PK `post_vote(post_id, voter_id)` + INSERT OR
 * IGNORE). When the cast changes state, recompute
 * `post_summary.score` + `hot_score`, mirror onto `user_vote`, bump
 * karma on the author's `user_profile`.
 */
export async function voteOnPost(
	env: Env,
	input: VoteOnPostInput,
): Promise<VoteOnPostResult> {
	return applyVote(env, input, true);
}

/**
 * Retract a previously-cast vote. Idempotent: retracting when no row
 * exists is a no-op (DELETE returns changes=0).
 */
export async function retractPostVote(
	env: Env,
	input: VoteOnPostInput,
): Promise<VoteOnPostResult> {
	return applyVote(env, input, false);
}

async function applyVote(
	env: Env,
	input: VoteOnPostInput,
	isVote: boolean,
): Promise<VoteOnPostResult> {
	// Load the post meta up-front so we can return the canonical resolver
	// shape (title / url / host / body / tags / commentCount / ...) regardless
	// of changed / no-op path.
	const db = drizzle(env.PHOENIX_DB, {schema});
	const meta = await db.query.postSummary.findFirst({
		where: and(eq(schema.postSummary.id, input.postId), isNull(schema.postSummary.deletedAt)),
	});
	if (!meta) {
		throw new PostNotFoundError(input.postId);
	}

	let voteResult;
	try {
		voteResult = await vote(env, {
			userId: input.voterId,
			targetKind: "post",
			targetId: input.postId,
			value: isVote ? 1 : null,
		});
	} catch (err) {
		// Race: the post was soft-deleted between our read and the vote
		// module's own existence check. Surface the pano-typed error so the
		// resolver codec keeps producing `POST_NOT_FOUND`.
		if (err instanceof VoteTargetNotFoundError) {
			throw new PostNotFoundError(input.postId);
		}
		throw err;
	}

	// The vote module's post adapter wrote `post_summary.score + hot_score`
	// inside its batch. Re-read so we surface the converged values without
	// re-deriving the formula here.
	const now = new Date();
	const refreshed = voteResult.changed
		? await db.query.postSummary.findFirst({where: eq(schema.postSummary.id, input.postId)})
		: meta;
	const score = refreshed?.score ?? voteResult.score;
	const hotScore = refreshed?.hotScore ?? meta.hotScore;

	return {
		postId: input.postId,
		title: meta.title,
		url: meta.url,
		host: meta.host,
		body: meta.body && meta.body.length > 0 ? meta.body : null,
		authorId: meta.authorId,
		authorName: meta.authorName,
		score,
		hotScore,
		commentCount: meta.commentCount,
		tags: parseTags(meta.tags),
		createdAt: meta.createdAt ?? now,
		myVote: voteResult.myVote,
		changed: voteResult.changed,
	};
}

/**
 * Edit a post's title / body. Ownership-checked. At least one of
 * `title` / `body` must be provided. Updates `title` (if given),
 * `body` + `bodyExcerpt` (if given), `updatedAt`, and recomputes
 * `hot_score` against `now` so frequent edits don't accidentally
 * re-rank the post.
 *
 * Empty / blank body clears to empty string (parity with submitPost's
 * `null` semantics on the response side; the DB column stays NOT NULL).
 */
export async function editPost(env: Env, input: EditPostInput): Promise<EditPostResult> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const meta = await db.query.postSummary.findFirst({
		where: and(eq(schema.postSummary.id, input.postId), isNull(schema.postSummary.deletedAt)),
	});
	if (!meta) {
		throw new PostNotFoundError(input.postId);
	}
	if (meta.authorId !== input.actorId) {
		throw new UnauthorizedPostMutationError(input.postId);
	}

	const hasTitle = input.title !== undefined;
	const hasBody = input.body !== undefined;
	if (!hasTitle && !hasBody) {
		throw new PostValidationError("title_required", "başlık veya metin gerekli");
	}

	let nextTitle = meta.title;
	if (hasTitle) {
		const trimmed = (input.title ?? "").trim();
		if (trimmed.length === 0) {
			throw new PostValidationError("title_required", "başlık boş olamaz");
		}
		if (trimmed.length > POST_TITLE_MAX) {
			throw new PostValidationError(
				"title_too_long",
				`başlık en fazla ${POST_TITLE_MAX} karakter olabilir`,
			);
		}
		nextTitle = trimmed;
	}

	let nextBody: string | null = meta.body && meta.body.length > 0 ? meta.body : null;
	let nextBodyStored = meta.body;
	let nextBodyExcerpt = meta.bodyExcerpt;
	if (hasBody) {
		const raw = input.body ?? "";
		if (raw.length > POST_BODY_MAX) {
			throw new PostValidationError(
				"body_too_long",
				`metin en fazla ${POST_BODY_MAX} karakter olabilir`,
			);
		}
		nextBody = raw.length === 0 ? null : raw;
		nextBodyStored = raw;
		nextBodyExcerpt = nextBody ? excerpt(nextBody) : "";
	}

	const now = new Date();
	const createdAtMs = meta.createdAt ? meta.createdAt.getTime() : now.getTime();
	const hotScore = computeHotScore(meta.score, createdAtMs, now.getTime());

	await db
		.update(schema.postSummary)
		.set({
			title: nextTitle,
			body: nextBodyStored,
			bodyExcerpt: nextBodyExcerpt,
			hotScore,
			updatedAt: now,
			lastActivityAt: now,
		})
		.where(eq(schema.postSummary.id, input.postId));

	return {
		postId: input.postId,
		title: nextTitle,
		url: meta.url,
		host: meta.host,
		body: nextBody,
		authorId: meta.authorId,
		authorName: meta.authorName,
		score: meta.score,
		hotScore,
		commentCount: meta.commentCount,
		tags: parseTags(meta.tags),
		createdAt: meta.createdAt ?? new Date(createdAtMs),
		updatedAt: now,
	};
}

/**
 * Delete a post. Ownership-checked. Idempotent: re-deleting a missing
 * row returns `deleted: false`. Mirrors the legacy `PostDeleted`
 * projection semantics: the row is fully removed from `post_summary`
 * (vs. soft-delete for definitions). Also wipes `post_vote` rows for
 * this post, the cross-product `user_vote` mirrors, and decrements the
 * author's karma by the previously-recorded score.
 */
export async function deletePost(
	env: Env,
	input: DeletePostInput,
): Promise<DeletePostResult> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const meta = await db.query.postSummary.findFirst({
		where: eq(schema.postSummary.id, input.postId),
	});
	if (!meta) {
		// Already gone (or never existed). Idempotent no-op — but flag
		// "not found" via name so the resolver can distinguish from a
		// successful delete if it ever wants to. For now we return
		// deleted: false. The legacy DO contract threw PostNotFoundError
		// when the row was missing entirely, but only after the ownership
		// check; with a fully-deleted row we have no author to check
		// against. Return no-op so re-delete from the same actor is
		// idempotent.
		return {postId: input.postId, deleted: false};
	}
	if (meta.authorId !== input.actorId) {
		throw new UnauthorizedPostMutationError(input.postId);
	}
	if (meta.deletedAt) {
		// In-progress soft-delete (legacy DO column). Treat as already
		// deleted — under D1-direct we fully remove the row below, so
		// future calls land in the `!meta` branch.
		return {postId: input.postId, deleted: false};
	}

	const now = new Date();
	const nowSec = Math.floor(now.getTime() / 1000);
	const priorScore = meta.score;

	// One batch carries every delete-time mutation: optional karma
	// decrement leads (only when there were votes to retract), then the
	// vote-table wipe (`post_vote`), then the cross-product mirror wipe
	// (`user_vote`), then the `post_summary` row removal itself. Matches
	// the atomic-mutation contract enforced by the vote module
	// (`vote/module.ts`) so a worker crash mid-delete can't leave karma
	// debited against a surviving post or orphan vote rows.
	//
	// `recomputePanoStats` stays outside the batch — it's a recomputable
	// cache refresh derived from current state, not part of the atomic
	// mutation.
	const stmts: D1PreparedStatement[] = [];
	if (priorScore > 0) {
		stmts.push(
			env.PHOENIX_DB.prepare(
				`UPDATE user_profile SET
					total_karma = MAX(0, total_karma - ?),
					updated_at  = ?
				WHERE user_id = ?`,
			).bind(priorScore, nowSec, meta.authorId),
		);
	}
	stmts.push(
		env.PHOENIX_DB.prepare(`DELETE FROM post_vote WHERE post_id = ?`).bind(input.postId),
	);
	stmts.push(
		env.PHOENIX_DB.prepare(
			`DELETE FROM user_vote WHERE target_kind = 'post' AND target_id = ?`,
		).bind(input.postId),
	);
	stmts.push(
		env.PHOENIX_DB.prepare(`DELETE FROM post_summary WHERE id = ?`).bind(input.postId),
	);

	await env.PHOENIX_DB.batch(stmts);

	await recomputePanoStats(env, now);

	return {postId: input.postId, deleted: true};
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Refresh `pano_stats` totals. Same shape as the legacy projection
 * helper — three small COUNT queries plus one upsert. Cheap; runs after
 * every write that could affect totals (submit + delete).
 */
async function recomputePanoStats(env: Env, now: Date): Promise<void> {
	const totalPosts = await env.PHOENIX_DB.prepare(
		`SELECT COUNT(*) as n FROM post_summary WHERE deleted_at IS NULL`,
	).first<{n: number}>();
	const totalComments = await env.PHOENIX_DB.prepare(
		`SELECT COUNT(*) as n FROM comment_view WHERE deleted_at IS NULL`,
	).first<{n: number}>();
	const totalAuthors = await env.PHOENIX_DB.prepare(
		`SELECT COUNT(DISTINCT author_id) as n FROM (
			SELECT author_id FROM post_summary WHERE deleted_at IS NULL
			UNION
			SELECT author_id FROM comment_view WHERE deleted_at IS NULL
		)`,
	).first<{n: number}>();

	const nowSec = Math.floor(now.getTime() / 1000);
	await env.PHOENIX_DB.prepare(
		`INSERT INTO pano_stats (id, total_posts, total_comments, total_authors, updated_at)
		 VALUES (1, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
			total_posts    = excluded.total_posts,
			total_comments = excluded.total_comments,
			total_authors  = excluded.total_authors,
			updated_at     = excluded.updated_at`,
	)
		.bind(totalPosts?.n ?? 0, totalComments?.n ?? 0, totalAuthors?.n ?? 0, nowSec)
		.run();
}

/* -------------------------------------------------------------------------- */
/* Comment domain — types + errors                                             */
/* -------------------------------------------------------------------------- */

/** Comment body cap (per PRD: ≤ 5 000 chars). */
export const COMMENT_BODY_MAX = 5_000;

/**
 * Placeholder body rendered in place of a soft-deleted comment that still has
 * non-deleted replies (parent-with-replies path). Used by both the per-post
 * thread reader and the cross-product profile feed so the tree shape is
 * identical across both surfaces. Mirrors the legacy DO/projection contract.
 */
export const SILINDI_PLACEHOLDER = "[silindi]";

/**
 * Validation error thrown by `addComment` / `editComment`. The GraphQL
 * resolver routes this through `encodeMutationError` to a
 * stable `extensions.code` so the SPA can localize without parsing free-text
 * messages.
 *
 * `parent_not_found` is the same-post invariant: a nested reply must
 * reference an existing non-deleted comment on the SAME post. Under
 * D1-direct, "same post" is no longer enforced by the routing boundary
 * (every comment lives in one `comment_view` table); the module enforces
 * it explicitly via `WHERE id = ? AND post_id = ? AND deleted_at IS NULL`.
 */
export class CommentValidationError extends Error {
	constructor(
		readonly code: "body_required" | "body_too_long" | "parent_not_found",
		message: string,
	) {
		super(message);
		this.name = "CommentValidationError";
	}
}

/**
 * Raised by every comment mutation that targets a missing or already-
 * removed comment. The resolver translates this to
 * `extensions.code = COMMENT_NOT_FOUND`.
 */
export class CommentNotFoundError extends Error {
	readonly code = "comment_not_found" as const;
	constructor(commentId: string) {
		super(`comment ${commentId} not found`);
		this.name = "CommentNotFoundError";
	}
}

/**
 * Raised by `editComment` / `deleteComment` when the calling user is not
 * the comment's author. The resolver translates this to a clean
 * `UNAUTHORIZED` extension code (codec match on `name`).
 */
export class UnauthorizedCommentMutationError extends Error {
	readonly code = "unauthorized" as const;
	constructor(commentId: string) {
		super(`not authorized to mutate comment ${commentId}`);
		this.name = "UnauthorizedCommentMutationError";
	}
}

/* -------------------------------------------------------------------------- */
/* Comment read shapes                                                          */
/* -------------------------------------------------------------------------- */

export interface CommentRow {
	id: string;
	parentId: string | null;
	author: string;
	/**
	 * Pasaport user id of the comment's author. Powers the frontend's
	 * "is the current user the author?" check that gates edit / delete
	 * affordances. Empty string for `[silindi]` placeholder rows.
	 */
	authorId: string;
	body: string;
	score: number;
	createdAt: Date;
	updatedAt: Date;
	/**
	 * Soft-delete timestamp surfaced for the reply-aware projection: a
	 * parent-with-replies row appears with `body = '[silindi]'` AND
	 * `deletedAt` set so the SPA can render the placeholder via a typed
	 * `deletedAt != null` check rather than the fragile body-string match.
	 */
	deletedAt?: Date | null;
}

export interface CommentConnectionPage {
	rows: CommentRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

/* -------------------------------------------------------------------------- */
/* Comment mutation shapes                                                      */
/* -------------------------------------------------------------------------- */

export interface AddCommentInput {
	postId: string;
	authorId: string;
	authorName: string;
	body: string;
	/** Optional parent comment id for nested replies. Must reference an
	 *  existing non-deleted comment on the same post. */
	parentId?: string | null | undefined;
}

export interface AddCommentResult {
	commentId: string;
	postId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	commentCount: number;
	createdAt: Date;
}

export interface VoteOnCommentInput {
	commentId: string;
	voterId: string;
}

export interface VoteOnCommentResult {
	commentId: string;
	postId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	createdAt: Date;
	/** `1` if the voter has voted on this comment (post-write), `null` otherwise. */
	myVote: number | null;
	/** `true` if the vote row state changed; `false` on idempotent no-op. */
	changed: boolean;
}

export interface EditCommentInput {
	commentId: string;
	actorId: string;
	body: string;
}

export interface EditCommentResult {
	commentId: string;
	postId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface DeleteCommentInput {
	commentId: string;
	actorId: string;
}

export interface DeleteCommentResult {
	commentId: string;
	/** `true` if the row was deleted (soft or hard); `false` on idempotent no-op. */
	deleted: boolean;
	/**
	 * `true` when the comment had at least one non-deleted child at delete
	 * time → tree-preserving `[silindi]` placeholder; `false` when the
	 * comment was a leaf → fully removed from the tree.
	 */
	hasReplies: boolean;
	/**
	 * The post-delete `[silindi]` placeholder row surfaced when
	 * `hasReplies === true`, so the GraphQL `deleteComment` resolver can
	 * return it without a follow-up read. `null` for the leaf path.
	 */
	placeholder: CommentRow | null;
}

/* -------------------------------------------------------------------------- */
/* Comment reads                                                                */
/* -------------------------------------------------------------------------- */

function rowToCommentRow(row: typeof schema.commentView.$inferSelect): CommentRow {
	// Reply-aware placeholder: a row with `deletedAt` set is the parent-with-
	// replies case (leaf-deleted rows are removed entirely from comment_view).
	// Surface the placeholder body + empty author so the SPA can render the
	// `[silindi]` row without a separate "is deleted?" branch.
	if (row.deletedAt) {
		return {
			id: row.id,
			parentId: row.parentId,
			author: "",
			authorId: "",
			body: SILINDI_PLACEHOLDER,
			score: row.score,
			createdAt: row.createdAt ?? new Date(0),
			updatedAt: row.updatedAt ?? row.createdAt ?? new Date(0),
			deletedAt: row.deletedAt,
		};
	}
	return {
		id: row.id,
		parentId: row.parentId,
		author: row.authorName,
		authorId: row.authorId,
		body: row.body,
		score: row.score,
		createdAt: row.createdAt ?? new Date(0),
		updatedAt: row.updatedAt ?? row.createdAt ?? new Date(0),
		deletedAt: null,
	};
}

/**
 * Read every comment for a post in chronological-asc order, then run the
 * reply-aware filter so a leaf-deleted row is NEVER returned (only the
 * `comment_view` UPDATE branch — parent-with-replies — should ever be
 * stored with `deleted_at` set; leaves are DELETEd in `deleteComment`).
 *
 * Returns rows already projected through `rowToCommentRow`, so callers
 * see placeholder bodies + empty authors for soft-deleted parents.
 */
export async function listComments(env: Env, postId: string): Promise<CommentRow[]> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const rows = await db
		.select()
		.from(schema.commentView)
		.where(eq(schema.commentView.postId, postId))
		.orderBy(asc(schema.commentView.createdAt), asc(schema.commentView.id));
	return rows.map(rowToCommentRow);
}

/**
 * Connection-shaped read for `Post.comments(first, after)`. Builds on
 * `listComments` (which already returns chronological-asc with the
 * reply-aware placeholder pass) and slices a forward page.
 *
 * Cursor is the comment id (forge ULID; lex-sortable, matches chronological
 * order). A stale `after` (no longer in the materialized list — either
 * never-existed or removed between pages) returns an empty page with
 * `hasNextPage: false` and `endCursor: null` so the FE store doesn't
 * accidentally re-render rows the user has already seen. Mirrors
 * `listPostConnection`'s `cursorMissed` early-return.
 */
export async function listCommentsConnection(
	env: Env,
	postId: string,
	opts: {first?: number | undefined; after?: string | null | undefined},
): Promise<CommentConnectionPage> {
	const all = await listComments(env, postId);
	const first = Math.max(1, Math.min(opts.first ?? 50, 200));
	const after = opts.after ?? null;
	if (after !== null && all.findIndex((c) => c.id === after) === -1) {
		// Stale cursor (row was deleted between pages, or never existed).
		// Terminate the stream: empty page + `hasNextPage: false` signals
		// end-of-cursor to the client. The FE must reconcile against its
		// store and, if it wants more rows, start a fresh pagination from
		// the head explicitly — we do NOT silently restart here.
		return {
			rows: [],
			hasNextPage: false,
			endCursor: null,
			totalCount: all.length,
		};
	}
	const startIndex = after ? all.findIndex((c) => c.id === after) + 1 : 0;
	const page = all.slice(startIndex, startIndex + first);
	const hasNextPage = startIndex + first < all.length;
	const last = page.at(-1) ?? null;
	return {
		rows: page,
		hasNextPage,
		endCursor: last ? last.id : null,
		totalCount: all.length,
	};
}

/**
 * Resolve a comment id to its post id via `comment_view`. Used by the
 * `voteOnComment` / `editComment` / `deleteComment` resolvers (the GraphQL
 * surface takes a comment id; under D1-direct everything lives in one
 * `comment_view`, but the read path mirrors the legacy reader's shape
 * because some callers still need the lookup for hydration).
 *
 * Returns `null` for unknown ids OR for leaf-deleted rows that were fully
 * removed from `comment_view`.
 */
export async function getCommentRow(
	env: Env,
	commentId: string,
): Promise<typeof schema.commentView.$inferSelect | null> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const row = await db.query.commentView.findFirst({
		where: eq(schema.commentView.id, commentId),
	});
	return row ?? null;
}

/* -------------------------------------------------------------------------- */
/* Comment mutations                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Add a top-level comment or a nested reply to an existing post. Mints
 * the comment id internally (forge ULID, `comm_` prefix).
 *
 * Validation (defense-in-depth — resolver enforces too):
 *   - `body` non-empty after trim, ≤ 5 000 chars
 *   - `parentId` (when provided) MUST reference an existing non-deleted
 *     comment on the SAME post.
 *
 * Writes (in dependency order, no transaction — see decision note on
 * `submitPost`):
 *   1. Insert `comment_view` row (full body + excerpt + author + parent_id).
 *   2. Bump `post_summary.commentCount` + refresh `lastActivityAt`,
 *      recompute `hot_score` against `now`.
 *   3. Recompute `pano_stats` totals.
 *
 * Returns the new comment id + the post's updated commentCount so the
 * resolver can shape the `Comment` response without a follow-up read.
 *
 * Throws:
 *   - `PostNotFoundError` for an unknown / deleted post.
 *   - `CommentValidationError` on validation failure.
 */
export async function addComment(
	env: Env,
	input: AddCommentInput,
): Promise<AddCommentResult> {
	const rawBody = input.body ?? "";
	if (rawBody.trim().length === 0) {
		throw new CommentValidationError("body_required", "yorum boş olamaz");
	}
	if (rawBody.length > COMMENT_BODY_MAX) {
		throw new CommentValidationError(
			"body_too_long",
			`yorum en fazla ${COMMENT_BODY_MAX} karakter olabilir`,
		);
	}

	const db = drizzle(env.PHOENIX_DB, {schema});

	const post = await db.query.postSummary.findFirst({
		where: and(eq(schema.postSummary.id, input.postId), isNull(schema.postSummary.deletedAt)),
	});
	if (!post) {
		throw new PostNotFoundError(input.postId);
	}

	const parentId = input.parentId ?? null;
	if (parentId !== null) {
		// Same-post + existence + not-soft-deleted invariant. Under D1-direct,
		// every comment lives in one `comment_view`, so we must enforce
		// `post_id = ?` explicitly (the legacy DO routing did this for us by
		// addressing the per-post DO).
		const parent = await db.query.commentView.findFirst({
			where: and(
				eq(schema.commentView.id, parentId),
				eq(schema.commentView.postId, input.postId),
				isNull(schema.commentView.deletedAt),
			),
		});
		if (!parent) {
			throw new CommentValidationError("parent_not_found", "yanıtlanan yorum bulunamadı");
		}
	}

	const now = new Date();
	const commentId = id("comm");
	const bodyExcerpt = excerpt(rawBody);

	await db.insert(schema.commentView).values({
		id: commentId,
		authorId: input.authorId,
		authorName: input.authorName,
		postId: input.postId,
		postTitle: post.title,
		parentId,
		body: rawBody,
		bodyExcerpt,
		score: 0,
		createdAt: now,
		updatedAt: now,
		deletedAt: null,
		lastEventId: "",
	});

	const newCommentCount = post.commentCount + 1;
	const hotScore = computeHotScore(
		post.score,
		(post.createdAt ?? now).getTime(),
		now.getTime(),
	);

	await db
		.update(schema.postSummary)
		.set({
			commentCount: newCommentCount,
			hotScore,
			updatedAt: now,
			lastActivityAt: now,
		})
		.where(eq(schema.postSummary.id, input.postId));

	await recomputePanoStats(env, now);

	return {
		commentId,
		postId: input.postId,
		parentId,
		authorId: input.authorId,
		authorName: input.authorName,
		body: rawBody,
		score: 0,
		commentCount: newCommentCount,
		createdAt: now,
	};
}

/**
 * Cast an up-vote on a comment. Idempotent: re-cast from the same voter is
 * a no-op. When the cast lands, recompute `comment_view.score`, mirror onto
 * `user_vote`, bump karma on the comment author's `user_profile`. Mirrors
 * `voteOnPost` and `voteDefinition`.
 */
export async function voteOnComment(
	env: Env,
	input: VoteOnCommentInput,
): Promise<VoteOnCommentResult> {
	return applyCommentVote(env, input, true);
}

/**
 * Retract a previously-cast comment vote. Idempotent: retracting when no
 * row exists is a no-op (DELETE returns changes=0).
 */
export async function retractCommentVote(
	env: Env,
	input: VoteOnCommentInput,
): Promise<VoteOnCommentResult> {
	return applyCommentVote(env, input, false);
}

async function applyCommentVote(
	env: Env,
	input: VoteOnCommentInput,
	isVote: boolean,
): Promise<VoteOnCommentResult> {
	// Load the comment row up-front for the canonical resolver shape
	// (postId / parentId / authorId / authorName / body / createdAt). The
	// vote module's comment adapter handles all writes.
	const db = drizzle(env.PHOENIX_DB, {schema});
	const row = await db.query.commentView.findFirst({
		where: and(eq(schema.commentView.id, input.commentId), isNull(schema.commentView.deletedAt)),
	});
	if (!row) {
		throw new CommentNotFoundError(input.commentId);
	}

	let voteResult;
	try {
		voteResult = await vote(env, {
			userId: input.voterId,
			targetKind: "comment",
			targetId: input.commentId,
			value: isVote ? 1 : null,
		});
	} catch (err) {
		// Race: the comment was soft-deleted between our read and the vote
		// module's own existence check. Translate so the resolver codec keeps
		// producing `COMMENT_NOT_FOUND`.
		if (err instanceof VoteTargetNotFoundError) {
			throw new CommentNotFoundError(input.commentId);
		}
		throw err;
	}

	const now = new Date();
	return {
		commentId: input.commentId,
		postId: row.postId,
		parentId: row.parentId,
		authorId: row.authorId,
		authorName: row.authorName,
		body: row.body,
		score: voteResult.score,
		createdAt: row.createdAt ?? now,
		myVote: voteResult.myVote,
		changed: voteResult.changed,
	};
}

/**
 * Edit a comment's body. Ownership-checked. Refreshes `body`,
 * `body_excerpt`, and `updatedAt`. Score/threading untouched.
 *
 * Throws:
 *   - `CommentNotFoundError` when the comment doesn't exist or is
 *     soft-deleted (a deleted comment cannot be edited).
 *   - `UnauthorizedCommentMutationError` on author mismatch.
 *   - `CommentValidationError` on body validation failure.
 */
export async function editComment(
	env: Env,
	input: EditCommentInput,
): Promise<EditCommentResult> {
	const rawBody = input.body ?? "";
	if (rawBody.trim().length === 0) {
		throw new CommentValidationError("body_required", "yorum boş olamaz");
	}
	if (rawBody.length > COMMENT_BODY_MAX) {
		throw new CommentValidationError(
			"body_too_long",
			`yorum en fazla ${COMMENT_BODY_MAX} karakter olabilir`,
		);
	}

	const db = drizzle(env.PHOENIX_DB, {schema});
	const row = await db.query.commentView.findFirst({
		where: and(eq(schema.commentView.id, input.commentId), isNull(schema.commentView.deletedAt)),
	});
	if (!row) {
		throw new CommentNotFoundError(input.commentId);
	}
	if (row.authorId !== input.actorId) {
		throw new UnauthorizedCommentMutationError(input.commentId);
	}

	const now = new Date();
	const bodyExcerpt = excerpt(rawBody);

	await db
		.update(schema.commentView)
		.set({body: rawBody, bodyExcerpt, updatedAt: now})
		.where(eq(schema.commentView.id, input.commentId));

	return {
		commentId: input.commentId,
		postId: row.postId,
		parentId: row.parentId,
		authorId: row.authorId,
		authorName: row.authorName,
		body: rawBody,
		score: row.score,
		createdAt: row.createdAt ?? now,
		updatedAt: now,
	};
}

/**
 * Soft-delete a comment, with reply-aware behavior:
 *
 *   - **Leaf** (no non-deleted children): fully remove the `comment_view`
 *     row + drop vote rows + decrement post.commentCount + karma. The
 *     row disappears entirely from `Post.comments` reads.
 *   - **Parent-with-replies**: stamp `deleted_at` + rewrite `body_excerpt`
 *     to `[silindi]` + drop vote rows + decrement post.commentCount +
 *     karma. The row stays in `Post.comments` reads but renders as the
 *     placeholder (preserves thread shape).
 *
 * Ownership-checked. Idempotent: re-deleting a missing row returns
 * `deleted: false` (matches the legacy DO contract). Re-deleting an
 * already-soft-deleted row also returns `deleted: false`.
 *
 * Karma decrement: votes that no longer count toward the author's karma
 * after the row disappears (parent-with-replies path keeps the placeholder
 * but the votes drop, matching the legacy projection's behavior).
 *
 * Throws:
 *   - `CommentNotFoundError` for an unknown comment id (no row at all).
 *   - `UnauthorizedCommentMutationError` on author mismatch.
 */
export async function deleteComment(
	env: Env,
	input: DeleteCommentInput,
): Promise<DeleteCommentResult> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const row = await db.query.commentView.findFirst({
		where: eq(schema.commentView.id, input.commentId),
	});
	if (!row) {
		throw new CommentNotFoundError(input.commentId);
	}
	if (row.authorId !== input.actorId) {
		throw new UnauthorizedCommentMutationError(input.commentId);
	}
	if (row.deletedAt) {
		// Already soft-deleted (parent-with-replies path). Idempotent no-op.
		return {
			commentId: input.commentId,
			deleted: false,
			hasReplies: true,
			placeholder: rowToCommentRow(row),
		};
	}

	// hasReplies: at least one non-deleted child of this comment exists.
	const childCountRow = await env.PHOENIX_DB.prepare(
		`SELECT COUNT(*) as n FROM comment_view
		 WHERE parent_id = ? AND deleted_at IS NULL`,
	)
		.bind(input.commentId)
		.first<{n: number}>();
	const hasReplies = (childCountRow?.n ?? 0) > 0;

	const now = new Date();
	const nowSec = Math.floor(now.getTime() / 1000);
	const priorScore = row.score;

	// One batch carries every delete-time mutation: optional karma
	// decrement leads (only when there were votes to retract), then the
	// vote-table wipe (`comment_vote`), then the cross-product mirror wipe
	// (`user_vote`), then the branch-dependent terminal — `UPDATE
	// comment_view` for parent-with-replies (soft-delete) or `DELETE FROM
	// comment_view` for leaves (hard-delete). Matches the atomic-mutation
	// contract enforced by the vote module (`vote/module.ts`) and by
	// `deletePost` above, so a worker crash mid-delete can't leave karma
	// debited against a surviving comment or orphan vote rows.
	//
	// The post `commentCount` decrement and `recomputePanoStats` stay
	// outside the batch — both are recomputable cache refreshes derived
	// from current state, not part of the atomic mutation.
	const stmts: D1PreparedStatement[] = [];
	if (priorScore > 0) {
		stmts.push(
			env.PHOENIX_DB.prepare(
				`UPDATE user_profile SET
					total_karma = MAX(0, total_karma - ?),
					updated_at  = ?
				WHERE user_id = ?`,
			).bind(priorScore, nowSec, row.authorId),
		);
	}
	stmts.push(
		env.PHOENIX_DB.prepare(`DELETE FROM comment_vote WHERE comment_id = ?`).bind(input.commentId),
	);
	stmts.push(
		env.PHOENIX_DB.prepare(
			`DELETE FROM user_vote WHERE target_kind = 'comment' AND target_id = ?`,
		).bind(input.commentId),
	);
	if (hasReplies) {
		// Parent-with-replies: stamp deleted_at + rewrite body_excerpt.
		// Drop the full body (the placeholder doesn't need it) so storage
		// doesn't carry stale content.
		stmts.push(
			env.PHOENIX_DB.prepare(
				`UPDATE comment_view SET
					body          = '',
					body_excerpt  = ?,
					score         = 0,
					deleted_at    = ?,
					updated_at    = ?
				WHERE id = ?`,
			).bind(SILINDI_PLACEHOLDER, nowSec, nowSec, input.commentId),
		);
	} else {
		// Leaf: fully remove the row.
		stmts.push(
			env.PHOENIX_DB.prepare(`DELETE FROM comment_view WHERE id = ?`).bind(input.commentId),
		);
	}

	await env.PHOENIX_DB.batch(stmts);

	// Decrement post.commentCount (reads filter deleted_at OR rows that no
	// longer exist).
	const post = await db.query.postSummary.findFirst({
		where: eq(schema.postSummary.id, row.postId),
	});
	if (post) {
		const newCommentCount = Math.max(0, post.commentCount - 1);
		const hotScore = computeHotScore(
			post.score,
			(post.createdAt ?? now).getTime(),
			now.getTime(),
		);
		await db
			.update(schema.postSummary)
			.set({
				commentCount: newCommentCount,
				hotScore,
				updatedAt: now,
				lastActivityAt: now,
			})
			.where(eq(schema.postSummary.id, row.postId));
	}

	await recomputePanoStats(env, now);

	const placeholder: CommentRow | null = hasReplies
		? {
				id: input.commentId,
				parentId: row.parentId,
				author: "",
				authorId: "",
				body: SILINDI_PLACEHOLDER,
				score: 0,
				createdAt: row.createdAt ?? new Date(0),
				updatedAt: now,
				deletedAt: now,
			}
		: null;

	return {commentId: input.commentId, deleted: true, hasReplies, placeholder};
}

// Silence drizzle's "unused import" for `sql` — kept for parity with
// sibling modules + likely use when this module grows raw expressions.
void sql;
