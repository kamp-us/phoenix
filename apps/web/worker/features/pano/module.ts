/**
 * Pano — D1-direct module (task_7, d1-direct).
 *
 * Every function in this file reads/writes `env.PHOENIX_DB` via drizzle.
 * There is no Durable Object boundary, no workflow `create`, no outbox /
 * projection step. The legacy `PanoPost` Agent DO class still exists at
 * this stage but its POST-related methods are unreferenced — task_8
 * migrates comment surfaces, then task_9 deletes the class entirely.
 *
 * Surface (resolver-callable, post-side; comments still on the DO until
 * task_8):
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
 *
 * Vote logic for posts is inlined here at task_7; consolidation into a
 * shared vote module happens in task_11. Mirrors `applyVote` from
 * `worker/features/sozluk/module.ts`.
 *
 * Errors thrown by this module flow through the GraphQL `resolver()`
 * wrapper (see `worker/graphql/resolver.ts`) which routes them through
 * `encodeMutationError` for the wire-format `extensions.code`.
 */
import {id} from "@usirin/forge";
import {and, eq, isNull, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "../../db/drizzle/schema";

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
	const db = drizzle(env.PHOENIX_DB, {schema});
	const meta = await db.query.postSummary.findFirst({
		where: and(eq(schema.postSummary.id, input.postId), isNull(schema.postSummary.deletedAt)),
	});
	if (!meta) {
		throw new PostNotFoundError(input.postId);
	}

	const now = new Date();
	const nowSec = Math.floor(now.getTime() / 1000);
	const createdAtMs = meta.createdAt ? meta.createdAt.getTime() : now.getTime();

	let changed = false;
	if (isVote) {
		const result = await env.PHOENIX_DB.prepare(
			`INSERT OR IGNORE INTO post_vote (post_id, voter_id, created_at)
			 VALUES (?, ?, ?)`,
		)
			.bind(input.postId, input.voterId, nowSec)
			.run();
		changed = (result.meta.changes ?? 0) > 0;
	} else {
		const result = await env.PHOENIX_DB.prepare(
			`DELETE FROM post_vote WHERE post_id = ? AND voter_id = ?`,
		)
			.bind(input.postId, input.voterId)
			.run();
		changed = (result.meta.changes ?? 0) > 0;
	}

	if (!changed) {
		const myVote = await readVotePresence(env, input.voterId, input.postId);
		return {
			postId: input.postId,
			title: meta.title,
			url: meta.url,
			host: meta.host,
			body: meta.body && meta.body.length > 0 ? meta.body : null,
			authorId: meta.authorId,
			authorName: meta.authorName,
			score: meta.score,
			hotScore: meta.hotScore,
			commentCount: meta.commentCount,
			tags: parseTags(meta.tags),
			createdAt: meta.createdAt ?? now,
			myVote,
			changed: false,
		};
	}

	// Recompute denormalized score from the truth table.
	const scoreRow = await env.PHOENIX_DB.prepare(
		`SELECT COUNT(*) as n FROM post_vote WHERE post_id = ?`,
	)
		.bind(input.postId)
		.first<{n: number}>();
	const newScore = scoreRow?.n ?? 0;
	const newHotScore = computeHotScore(newScore, createdAtMs, now.getTime());

	await db
		.update(schema.postSummary)
		.set({score: newScore, hotScore: newHotScore, updatedAt: now, lastActivityAt: now})
		.where(eq(schema.postSummary.id, input.postId));

	// Mirror onto cross-product `user_vote` MV + karma counter.
	if (isVote) {
		await env.PHOENIX_DB.prepare(
			`INSERT OR IGNORE INTO user_vote (user_id, target_kind, target_id, created_at)
			 VALUES (?, 'post', ?, ?)`,
		)
			.bind(input.voterId, input.postId, nowSec)
			.run();

		await env.PHOENIX_DB.prepare(
			`INSERT INTO user_profile (
				user_id, username, display_name, image,
				total_karma, definition_count, post_count, comment_count,
				updated_at, last_event_id
			) VALUES (?, NULL, NULL, NULL, 1, 0, 0, 0, ?, '')
			ON CONFLICT(user_id) DO UPDATE SET
				total_karma = user_profile.total_karma + 1,
				updated_at  = excluded.updated_at`,
		)
			.bind(meta.authorId, nowSec)
			.run();
	} else {
		await env.PHOENIX_DB.prepare(
			`DELETE FROM user_vote WHERE user_id = ? AND target_kind = 'post' AND target_id = ?`,
		)
			.bind(input.voterId, input.postId)
			.run();

		await env.PHOENIX_DB.prepare(
			`UPDATE user_profile SET
				total_karma = MAX(0, total_karma - 1),
				updated_at  = ?
			WHERE user_id = ?`,
		)
			.bind(nowSec, meta.authorId)
			.run();
	}

	return {
		postId: input.postId,
		title: meta.title,
		url: meta.url,
		host: meta.host,
		body: meta.body && meta.body.length > 0 ? meta.body : null,
		authorId: meta.authorId,
		authorName: meta.authorName,
		score: newScore,
		hotScore: newHotScore,
		commentCount: meta.commentCount,
		tags: parseTags(meta.tags),
		createdAt: meta.createdAt ?? now,
		myVote: isVote ? 1 : null,
		changed: true,
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

	// Decrement karma for the author by the prior score (votes that no
	// longer exist after the delete). Mirrors the legacy `PostDeleted`
	// projection step which removed `user_vote` rows + decremented karma.
	if (priorScore > 0) {
		await env.PHOENIX_DB.prepare(
			`UPDATE user_profile SET
				total_karma = MAX(0, total_karma - ?),
				updated_at  = ?
			WHERE user_id = ?`,
		)
			.bind(priorScore, nowSec, meta.authorId)
			.run();
	}

	// Drop vote rows for this post (truth table + cross-product mirror).
	await env.PHOENIX_DB.prepare(`DELETE FROM post_vote WHERE post_id = ?`)
		.bind(input.postId)
		.run();
	await env.PHOENIX_DB.prepare(
		`DELETE FROM user_vote WHERE target_kind = 'post' AND target_id = ?`,
	)
		.bind(input.postId)
		.run();

	// Fully remove the post_summary row.
	await db.delete(schema.postSummary).where(eq(schema.postSummary.id, input.postId));

	await recomputePanoStats(env, now);

	return {postId: input.postId, deleted: true};
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

async function readVotePresence(
	env: Env,
	voterId: string,
	postId: string,
): Promise<number | null> {
	const row = await env.PHOENIX_DB.prepare(
		`SELECT post_id FROM post_vote
		 WHERE post_id = ? AND voter_id = ?
		 LIMIT 1`,
	)
		.bind(postId, voterId)
		.first<{post_id: string}>();
	return row ? 1 : null;
}

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

// Silence drizzle's "unused import" for `sql` — kept for parity with
// sibling modules + likely use when this module grows raw expressions.
void sql;
