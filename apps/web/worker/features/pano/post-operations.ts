/**
 * Pano's **posts plane** — the post half of the `Pano` service: post CRUD, the
 * draft lifecycle, vote delegation, the moderator soft-delete/restore pair, and the
 * connection-shaped feed/by-id reads. `makePostOperations` is the layer-build
 * factory: `PanoLive` hands it the shared runtime deps and spreads the returned
 * closures into the service object, so the wire surface is unchanged from when these
 * lived inline in `Pano.ts`.
 *
 * Submit-validation lives here as module-private pure functions (ADR 0013 for
 * *where* validation belongs, ADR 0082 for *why* it's lifted off the service): each
 * is wrong-or-right on its input with no DB. The wire codes unit-test off-DB THROUGH
 * the mutation (`submit-validation.unit.test.ts` drives `submitPost` / `saveDraft` /
 * `editPost` over a throwing `Drizzle`, proving the gate fires before any DB call),
 * and the integration tier keeps only the real-DB-miss cases.
 *
 * Validation lives in the service methods, not resolvers (ADR 0013).
 */
import {id} from "@usirin/forge";
import {and, desc, eq, inArray, isNull, sql} from "drizzle-orm";
import {Effect} from "effect";
import {POST_SORT_LEAD_COLUMN, type PostSort} from "../../../src/lib/panoFeedSort.ts";
import {isPostTagKind} from "../../../src/lib/panoTags.ts";
import type {DrizzleAccessOrDie} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {computeHotScore} from "../../db/hotScore.ts";
import {emptyKeysetPage, forwardPage, keysetAfter, resolveCursor} from "../../db/keyset.ts";
import type {ReactionEmoji} from "../../db/reaction-emoji.ts";
import {stampReactionAggregate} from "../fate/reaction-aggregate.ts";
import {stampViewerScalars} from "../fate/viewer-scalars.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import * as Removal from "../lifecycle/removal.ts";
import {
	resolveSandboxViewer,
	sandboxBacklogWhere,
	sandboxVisibleWhere,
} from "../lifecycle/SandboxVisibility.ts";
import type {ReactionTargetNotFound} from "../reaction/errors.ts";
import type {Reaction} from "../reaction/Reaction.ts";
import {syncPostSearch} from "../search/fts-sync.ts";
import {translateVoteMiss} from "../vote/translate-vote-miss.ts";
import type {Vote} from "../vote/Vote.ts";
import type {Bookmark} from "./Bookmark.ts";
import {
	PostBodyTooLong,
	PostNotFound,
	TagInvalid,
	TagsRequired,
	TitleRequired,
	TitleTooLong,
	UnauthorizedPostMutation,
	UrlInvalid,
} from "./errors.ts";
import {excerpt} from "./excerpt.ts";
import {postVisibleTo, postVisibleWhere} from "./PostVisibility.ts";
import type {PersistPanoStats} from "./pano-stats.ts";
import {
	type PostConnectionPage,
	type PostSummaryRow,
	type PostTagRow,
	parseTags,
	toPostPage,
	toPostSummaryKeysetRow,
	toPostSummaryRow,
} from "./post-fields.ts";

export const POST_TITLE_MAX = 200;
export const POST_BODY_MAX = 10_000;

/** Raw tag shape on submit/draft input — `label` is optional until normalized. */
export interface PostTagInput {
	kind: string;
	label?: string | undefined;
}

export interface SubmitPostInput {
	title: string;
	url?: string | undefined;
	body?: string | undefined;
	tags: ReadonlyArray<{kind: string; label?: string | undefined}>;
	authorId: string;
	authorName: string;
	/**
	 * The çaylak mod-only sandbox stamp (#1205), decided by the resolver from the
	 * authorship flag + author tier. `null`/absent ⇒ posted live (today's behavior).
	 */
	sandboxedAt?: Date | null | undefined;
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

export interface SaveDraftInput {
	authorId: string;
	authorName: string;
	title?: string | undefined;
	url?: string | undefined;
	body?: string | undefined;
	tags?: ReadonlyArray<{kind: string; label?: string | undefined}> | undefined;
}

/** A draft re-resolves like a fresh post; `isDraft` rides the wire as `true`. */
export interface SaveDraftResult extends SubmitPostResult {
	isDraft: true;
}

export interface DiscardDraftInput {
	authorId: string;
}

export interface DiscardDraftResult {
	postId: string | null;
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
	myVote: boolean;
	changed: boolean;
}

export interface ReactToPostInput {
	postId: string;
	userId: string;
	/**
	 * The reaction intent: a curated-palette member sets/changes the user's single
	 * reaction; `null` retracts it (toggle off). Already decoded against
	 * `ReactionEmojiSchema` at the wire boundary, so the service never sees a
	 * non-palette string.
	 */
	emoji: ReactionEmoji | null;
}

/**
 * `reactToPost` re-resolves the affected post like a read (the `post.save` idiom),
 * so the returned entity carries the freshly-stamped `reactions` aggregate the
 * mutation echoes back. `changed` is the service's idempotency signal (a re-react
 * of the same emoji, or a retract-when-none, is `false`).
 */
export interface ReactToPostResult {
	post: PostSummaryRow;
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
	/** Why the post is removed (ADR 0096). Defaults to `AuthorDeletion`. */
	reason?: Removal.RemovalReason;
}

export interface DeletePostResult {
	postId: string;
	deleted: boolean;
}

/**
 * A restore's result: whether it acted, and — for the live-broadcast decision — the
 * `sandboxedAt` the content landed back at (#1811). `null` ⇒ restored to `Live`
 * (broadcast via `alwaysLive`); non-null ⇒ restored to the çaylak sandbox, so the
 * mutation must suppress the live echo through `decidePublish`, matching the
 * create-time #1205 gate. Never broadcast a sandboxed restore to a public topic.
 */
export interface RestorePostResult {
	postId: string;
	deleted: boolean;
	sandboxedAt: Date | null;
}

/** Returns the normalized body (`null` for empty), or fails `PostBodyTooLong`. */
const validatePostBody = Effect.fn("Pano.validatePostBody")(function* (rawBody: string) {
	if (rawBody.length > POST_BODY_MAX) {
		return yield* new PostBodyTooLong({
			message: `metin en fazla ${POST_BODY_MAX} karakter olabilir`,
		});
	}
	return rawBody.length === 0 ? null : rawBody;
});

const validatePostTitle = Effect.fn("Pano.validatePostTitle")(function* (raw: string) {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return yield* new TitleRequired({
			message: "başlık boş olamaz",
		});
	}
	if (trimmed.length > POST_TITLE_MAX) {
		return yield* new TitleTooLong({
			message: `başlık en fazla ${POST_TITLE_MAX} karakter olabilir`,
		});
	}
	return trimmed;
});

/**
 * Draft title gate — `saveDraft` has no required title (a half-filled form
 * persists), only the length cap. Returns the trimmed title or fails
 * `TitleTooLong`.
 */
const validateDraftTitle = Effect.fn("Pano.validateDraftTitle")(function* (raw: string) {
	const trimmed = raw.trim();
	if (trimmed.length > POST_TITLE_MAX) {
		return yield* new TitleTooLong({
			message: `başlık en fazla ${POST_TITLE_MAX} karakter olabilir`,
		});
	}
	return trimmed;
});

/**
 * Parse an optional submit/draft URL to its normalized form + host. An empty or
 * absent URL yields `{host: null, urlNormalized: null}`; a malformed one fails
 * `UrlInvalid`. Shared by `submitPost` and `saveDraft`.
 */
const parseSubmitUrl = Effect.fn("Pano.parseSubmitUrl")(function* (url: string | null | undefined) {
	if (url == null || url.length === 0) {
		return {host: null, urlNormalized: null} as const;
	}
	const parsed = yield* Effect.try({
		try: () => new URL(url),
		catch: () => new UrlInvalid({message: "URL geçersiz"}),
	});
	return {host: parsed.host, urlNormalized: parsed.toString()} as const;
});

/**
 * `submitPost` tag normalization: at least one tag is required, every kind must
 * be in the fixed enum, duplicate kinds collapse. Fails `TagsRequired` /
 * `TagInvalid`.
 */
const normalizeSubmitTags = Effect.fn("Pano.normalizeSubmitTags")(function* (
	tags: ReadonlyArray<PostTagInput> | null | undefined,
) {
	if (!tags || tags.length === 0) {
		return yield* new TagsRequired({
			message: "en az bir etiket seç",
		});
	}
	const normalizedTags: PostTagRow[] = [];
	const seenKinds = new Set<string>();
	for (const t of tags) {
		const kind = (t.kind ?? "").trim();
		if (!isPostTagKind(kind)) {
			return yield* new TagInvalid({
				message: `geçersiz etiket: ${kind || "(boş)"}`,
			});
		}
		if (seenKinds.has(kind)) continue;
		seenKinds.add(kind);
		normalizedTags.push({kind, label: t.label?.trim() || kind});
	}
	return normalizedTags;
});

/**
 * `saveDraft` tag normalization: tags are optional (empty kinds skipped, not
 * rejected), but a non-empty kind outside the fixed enum still fails
 * `TagInvalid`.
 */
const normalizeDraftTags = Effect.fn("Pano.normalizeDraftTags")(function* (
	tags: ReadonlyArray<PostTagInput> | null | undefined,
) {
	const normalizedTags: PostTagRow[] = [];
	const seenKinds = new Set<string>();
	for (const t of tags ?? []) {
		const kind = (t.kind ?? "").trim();
		if (kind.length === 0) continue;
		if (!isPostTagKind(kind)) {
			return yield* new TagInvalid({message: `geçersiz etiket: ${kind}`});
		}
		if (seenKinds.has(kind)) continue;
		seenKinds.add(kind);
		normalizedTags.push({kind, label: t.label?.trim() || kind});
	}
	return normalizedTags;
});

/** The shared runtime deps `PanoLive` threads into the posts plane. */
export interface PostOperationsDeps {
	readonly run: DrizzleAccessOrDie["run"];
	readonly batch: DrizzleAccessOrDie["batch"];
	readonly voteSvc: typeof Vote.Service;
	readonly bookmarkSvc: typeof Bookmark.Service;
	readonly reactionSvc: typeof Reaction.Service;
	readonly removalSeq: Removal.RemovalSequence;
	readonly persistPanoStats: PersistPanoStats;
}

export const makePostOperations = (deps: PostOperationsDeps) => {
	const {run, batch, voteSvc, bookmarkSvc, reactionSvc, removalSeq, persistPanoStats} = deps;

	// The viewer scalars for `Post` (#1126): `myVote` (batched `user_vote`) +
	// `isSaved` (batched `post_bookmark`). Every read finalizes through
	// `stampViewerScalars` with these specs — one `IN (...)` read per scalar for the
	// whole batch, never a per-row N+1 — so a new read path can't silently ship an
	// always-`null` scalar.
	const postViewerScalars = [
		{
			field: "myVote",
			read: (viewerId: string | null | undefined, ids: ReadonlyArray<string>) =>
				voteSvc.readMine(viewerId, "post", ids),
		},
		{
			field: "isSaved",
			read: (viewerId: string | null | undefined, ids: ReadonlyArray<string>) =>
				bookmarkSvc.readMine(viewerId, ids),
		},
	] as const;

	const rowToPostPage = toPostPage;

	const getPost = Effect.fn("Pano.getPost")(function* (
		postId: string,
		opts: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined} = {},
	) {
		const meta = yield* run((db) =>
			db.query.postRecord.findFirst({
				where: {id: postId, removedAt: {isNull: true}},
			}),
		);
		if (!meta) return null;
		// The in-memory visibility decision via the ADR 0113 seam (`postVisibleTo`) —
		// the mirror of the SQL `postVisibleWhere` the batch read uses, applied here
		// because this single-row read uses the relational query builder. It composes
		// the lifecycle + sandbox gate with the author-only draft arm, so a draft the
		// viewer doesn't own reads as not-found while the author reads their own.
		if (
			!postVisibleTo(
				Removal.fromColumns(meta),
				Boolean(meta.isDraft),
				meta.authorId,
				resolveSandboxViewer(opts),
			)
		) {
			return null;
		}
		return rowToPostPage(meta);
	});

	const listPostsConnection = Effect.fn("Pano.listPostsConnection")(function* (
		opts: {
			sort?: PostSort;
			first?: number;
			after?: string | null;
			host?: string | null;
			sandboxViewer?: SandboxViewer | undefined;
		} = {},
	) {
		const sort = opts.sort ?? "hot";
		const first = Math.max(1, Math.min(opts.first ?? 20, 100));
		const after = opts.after ?? null;
		const host = opts.host ?? null;

		// `is_draft IS NOT 1` excludes drafts from the public feed while keeping
		// null/0 rows (published) — drafts are private to their author (#746).
		const baseConditions = [
			isNull(schema.postRecord.removedAt),
			sql`${schema.postRecord.isDraft} is not 1`,
		];
		if (host) baseConditions.push(eq(schema.postRecord.host, host));
		// Filter the çaylak sandbox (#1205) for this viewer at the same layer.
		const sandboxClause = sandboxVisibleWhere(
			{sandboxedAt: schema.postRecord.sandboxedAt, authorId: schema.postRecord.authorId},
			resolveSandboxViewer(opts),
		);
		if (sandboxClause) baseConditions.push(sandboxClause);

		const totalCount = yield* run((db) =>
			db
				.select({n: sql<number>`count(*)`})
				.from(schema.postRecord)
				.where(and(...baseConditions))
				.get()
				.then((r) => r?.n ?? 0),
		);

		type CursorRow = {
			id: string;
			score: number;
			hotScore: number;
			commentCount: number;
			createdAt: Date | null;
		};
		const resolvedRow = after
			? ((yield* run((db) =>
					db
						.select({
							id: schema.postRecord.id,
							score: schema.postRecord.score,
							hotScore: schema.postRecord.hotScore,
							commentCount: schema.postRecord.commentCount,
							createdAt: schema.postRecord.createdAt,
						})
						.from(schema.postRecord)
						.where(eq(schema.postRecord.id, after))
						.get(),
				)) ?? null)
			: null;
		const cursor = resolveCursor<CursorRow>(after, resolvedRow);
		if (cursor.kind === "miss") {
			return {...emptyKeysetPage, totalCount} satisfies PostConnectionPage;
		}
		const cursorRow = cursor.kind === "hit" ? cursor.row : null;

		// Both the keyset cursor predicate and `orderBy` derive from the one
		// `POST_SORT_LEAD_COLUMN` map: an optional lead column (descending) +
		// `id` desc tiebreaker; `new` (no lead column) orders by `id` alone.
		const leadKey = POST_SORT_LEAD_COLUMN[sort];
		const leadColumn = leadKey
			? {column: schema.postRecord[leadKey], value: cursorRow?.[leadKey]}
			: null;

		const cursorPredicate = keysetAfter([
			...(leadColumn
				? [{column: leadColumn.column, dir: "desc" as const, value: leadColumn.value ?? null}]
				: []),
			{column: schema.postRecord.id, dir: "desc", value: cursorRow?.id ?? null},
		]);

		const whereExpr = cursorPredicate
			? and(...baseConditions, cursorPredicate)
			: and(...baseConditions);

		const orderBy = [...(leadColumn ? [desc(leadColumn.column)] : []), desc(schema.postRecord.id)];

		const fetched = yield* run((db) =>
			db
				.select({
					id: schema.postRecord.id,
					slug: schema.postRecord.slug,
					title: schema.postRecord.title,
					url: schema.postRecord.url,
					host: schema.postRecord.host,
					bodyExcerpt: schema.postRecord.bodyExcerpt,
					authorId: schema.postRecord.authorId,
					authorName: schema.postRecord.authorName,
					score: schema.postRecord.score,
					commentCount: schema.postRecord.commentCount,
					createdAt: schema.postRecord.createdAt,
					tags: schema.postRecord.tags,
				})
				.from(schema.postRecord)
				.where(whereExpr)
				.orderBy(...orderBy)
				.limit(first + 1),
		);

		// Route the keyset projection through the same `post-fields.ts` column→field
		// map the by-id path uses, so `body` collapses to `null` for an empty excerpt
		// (not `""`) — the divergence is unrepresentable, not hand-synced (#1170).
		const page = forwardPage(fetched, first, (r) => r.id, toPostSummaryKeysetRow);

		return {...page, totalCount} satisfies PostConnectionPage;
	});

	const getPostsByIds = Effect.fn("Pano.getPostsByIds")(function* (
		ids: ReadonlyArray<string>,
		opts: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined} = {},
	) {
		if (ids.length === 0) return [];
		const viewerId = opts.viewerId ?? null;
		const fetched = yield* run((db) =>
			db
				.select()
				.from(schema.postRecord)
				.where(
					and(
						inArray(schema.postRecord.id, [...ids]),
						isNull(schema.postRecord.removedAt),
						postVisibleWhere(
							{
								sandboxedAt: schema.postRecord.sandboxedAt,
								authorId: schema.postRecord.authorId,
								isDraft: schema.postRecord.isDraft,
							},
							resolveSandboxViewer(opts),
						),
					),
				),
		);
		// `myVote`/`isSaved` are the viewer scalars, finalized via `stampViewerScalars`
		// (one `user_vote` + one `post_bookmark` read for the whole batch); the row's
		// intrinsic fields come from the `post-fields.ts` column→field map. The
		// draft/ownership gate is enforced in SQL by `postVisibleWhere` above — a draft
		// the viewer doesn't own never reaches this batch — so a surviving `isDraft` row
		// is the author's own: read-your-writes, now verified rather than assumed.
		const intrinsic = fetched.map(toPostSummaryRow);
		const scalared = yield* stampViewerScalars(intrinsic, viewerId, postViewerScalars);
		return yield* stampReactionAggregate(reactionSvc, "post", scalared, viewerId);
	});

	// The moderator sandbox-queue / promotion-backlog read model (#1205, the #1206
	// seam): a çaylak's still-sandboxed, not-removed posts — scoped to one author when
	// promotion flips their backlog. Authority is gated at the resolver; the service
	// read is unconditional.
	const listSandboxedPosts = Effect.fn("Pano.listSandboxedPosts")(function* (
		opts: {authorId?: string | undefined} = {},
	) {
		const fetched = yield* run((db) =>
			db
				.select()
				.from(schema.postRecord)
				.where(
					sandboxBacklogWhere(
						{
							sandboxedAt: schema.postRecord.sandboxedAt,
							removedAt: schema.postRecord.removedAt,
							authorId: schema.postRecord.authorId,
						},
						{authorId: opts.authorId},
					),
				)
				.orderBy(desc(schema.postRecord.createdAt)),
		);
		return fetched.map(toPostSummaryRow);
	});

	const submitPost = Effect.fn("Pano.submitPost")(function* (input: SubmitPostInput) {
		const title = yield* validatePostTitle(input.title ?? "");
		const body = yield* validatePostBody(input.body ?? "");
		const {host, urlNormalized} = yield* parseSubmitUrl(input.url);
		const normalizedTags = yield* normalizeSubmitTags(input.tags);

		const postId = id("post");
		const now = new Date();
		const hotScore = computeHotScore(0, now.getTime(), now.getTime());
		const bodyExcerpt = body ? excerpt(body) : null;
		const tagsCsv = normalizedTags.map((t) => t.kind).join(",");

		// Summary insert + its FTS dual-write in ONE batch — all-or-none, so a
		// crash mid-write can't orphan a `post_search` row against a missing
		// `post_record` row (the ADR 0080 lockstep invariant).
		yield* batch((db) => [
			db.insert(schema.postRecord).values({
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
				removedAt: null,
				sandboxedAt: input.sandboxedAt ?? null,
			}),
			...syncPostSearch(db, postId, title),
		]);

		yield* persistPanoStats(now);

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
		} satisfies SubmitPostResult;
	});

	// A draft is a partial post: the only gates are submit's length/sanity caps
	// (no required title/tags), so a half-filled form persists. One draft per
	// author is enforced by the partial unique index + this probe-then-upsert.
	const saveDraft = Effect.fn("Pano.saveDraft")(function* (input: SaveDraftInput) {
		const rawTitle = yield* validateDraftTitle(input.title ?? "");
		const body = yield* validatePostBody(input.body ?? "");
		const {host, urlNormalized} = yield* parseSubmitUrl(input.url);
		const normalizedTags = yield* normalizeDraftTags(input.tags);

		const now = new Date();
		const bodyExcerpt = body ? excerpt(body) : "";
		const tagsCsv = normalizedTags.map((t) => t.kind).join(",");

		const existing = yield* run((db) =>
			db.query.postRecord.findFirst({
				where: {authorId: input.authorId, isDraft: true},
				columns: {id: true, createdAt: true},
			}),
		);

		const postId = existing?.id ?? id("post");
		const createdAt = existing?.createdAt ?? now;
		const hotScore = computeHotScore(0, createdAt.getTime(), now.getTime());

		if (existing) {
			yield* run((db) =>
				db
					.update(schema.postRecord)
					.set({
						title: rawTitle,
						url: urlNormalized,
						host,
						body: body ?? "",
						bodyExcerpt,
						authorName: input.authorName,
						tags: tagsCsv,
						hotScore,
						updatedAt: now,
						lastActivityAt: now,
					})
					.where(eq(schema.postRecord.id, postId)),
			);
		} else {
			yield* run((db) =>
				db.insert(schema.postRecord).values({
					id: postId,
					slug: null,
					title: rawTitle,
					url: urlNormalized,
					host,
					body: body ?? "",
					bodyExcerpt,
					authorId: input.authorId,
					authorName: input.authorName,
					tags: tagsCsv,
					score: 0,
					commentCount: 0,
					hotScore,
					createdAt: now,
					updatedAt: now,
					lastActivityAt: now,
					removedAt: null,
					isDraft: true,
				}),
			);
		}

		// A draft is never in the public FTS table (it never lists publicly), so
		// no `syncPostSearch` dual-write and no `recomputePanoStats` — both are
		// public-surface bookkeeping that a private draft must not touch.

		return {
			postId,
			title: rawTitle,
			url: urlNormalized,
			host,
			body,
			authorId: input.authorId,
			authorName: input.authorName,
			score: 0,
			commentCount: 0,
			tags: normalizedTags,
			createdAt,
			isDraft: true,
		} satisfies SaveDraftResult;
	});

	const discardDraft = Effect.fn("Pano.discardDraft")(function* (input: DiscardDraftInput) {
		const existing = yield* run((db) =>
			db.query.postRecord.findFirst({
				where: {authorId: input.authorId, isDraft: true},
				columns: {id: true},
			}),
		);
		if (!existing) return {postId: null} satisfies DiscardDraftResult;
		yield* run((db) =>
			db
				.delete(schema.postRecord)
				.where(
					and(eq(schema.postRecord.authorId, input.authorId), eq(schema.postRecord.isDraft, true)),
				),
		);
		return {postId: existing.id} satisfies DiscardDraftResult;
	});

	const editPost = Effect.fn("Pano.editPost")(function* (input: EditPostInput) {
		const meta = yield* run((db) =>
			db.query.postRecord.findFirst({
				where: {id: input.postId, removedAt: {isNull: true}},
			}),
		);
		if (!meta) {
			return yield* new PostNotFound({
				postId: input.postId,
				message: `post ${input.postId} not found`,
			});
		}
		if (meta.authorId !== input.actorId) {
			return yield* new UnauthorizedPostMutation({
				postId: input.postId,
				message: `not authorized to mutate post ${input.postId}`,
			});
		}

		const hasTitle = input.title !== undefined;
		const hasBody = input.body !== undefined;
		if (!hasTitle && !hasBody) {
			return yield* new TitleRequired({
				message: "başlık veya metin gerekli",
			});
		}

		let nextTitle = meta.title;
		if (hasTitle) nextTitle = yield* validatePostTitle(input.title ?? "");

		let nextBody: string | null = meta.body && meta.body.length > 0 ? meta.body : null;
		let nextBodyStored = meta.body;
		let nextBodyExcerpt = meta.bodyExcerpt;
		if (hasBody) {
			const raw = input.body ?? "";
			nextBody = yield* validatePostBody(raw);
			nextBodyStored = raw;
			nextBodyExcerpt = nextBody ? excerpt(nextBody) : "";
		}

		const now = new Date();
		const createdAtMs = meta.createdAt ? meta.createdAt.getTime() : now.getTime();
		const hotScore = computeHotScore(meta.score, createdAtMs, now.getTime());

		// Summary update + its FTS re-sync in ONE batch so they move all-or-none
		// (ADR 0080). The body is out of v1 search scope, so a body-only edit
		// leaves the FTS row untouched — only the summary update batches alone.
		yield* batch((db) => [
			db
				.update(schema.postRecord)
				.set({
					title: nextTitle,
					body: nextBodyStored,
					bodyExcerpt: nextBodyExcerpt,
					hotScore,
					updatedAt: now,
					lastActivityAt: now,
				})
				.where(eq(schema.postRecord.id, input.postId)),
			...(hasTitle ? syncPostSearch(db, input.postId, nextTitle) : []),
		]);

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
		} satisfies EditPostResult;
	});

	// SOFT delete onto the ADR 0096 substrate: stamp the `Removed` triad, wipe
	// votes via `Vote.clearTarget` (karma KEPT — the pano karma-reversal is
	// deleted), drop the FTS row, recompute stats outside. Restore is the inverse.
	const deletePost = Effect.fn("Pano.deletePost")(function* (input: DeletePostInput) {
		const meta = yield* run((db) => db.query.postRecord.findFirst({where: {id: input.postId}}));
		if (!meta) {
			return {postId: input.postId, deleted: false} satisfies DeletePostResult;
		}
		if (meta.authorId !== input.actorId) {
			return yield* new UnauthorizedPostMutation({
				postId: input.postId,
				message: `not authorized to mutate post ${input.postId}`,
			});
		}
		const current = Removal.fromColumns(meta);
		if (Removal.isRemoved(current)) {
			return {postId: input.postId, deleted: false} satisfies DeletePostResult;
		}

		const now = new Date();
		const removed = Removal.toColumns(
			Removal.remove({
				removedAt: now,
				removedBy: input.actorId,
				reason: input.reason ?? new Removal.AuthorDeletion(),
				// Preserve the pre-delete sandbox marker through the removal so a
				// restore round-trips it faithfully (#1811) — a çaylak's sandboxed post
				// stays sandboxed across delete→restore, never self-escaping to Live.
				sandboxedAt: Removal.sandboxedAtOf(current),
			}),
		);
		yield* Removal.removeEntity(removalSeq, {kind: "post", id: input.postId}, removed, now);

		// The removal is committed (source of truth). `persistPanoStats` is a recomputable
		// cache refresh (ADR 0011/0117) running AFTER the commit — it runs over
		// `DrizzleAccessOrDie`, so a D1 hiccup dies, and that must NOT flip an already-
		// committed delete into a raw 500 (the partial-commit-then-500, #1639). Swallow +
		// log like the fire-and-forget live-publish (ADR 0039); totals recompute next write.
		yield* persistPanoStats(now).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("pano-stats refresh after post delete failed", cause),
			),
		);

		return {postId: input.postId, deleted: true} satisfies DeletePostResult;
	});

	const restorePost = Effect.fn("Pano.restorePost")(function* (input: DeletePostInput) {
		const meta = yield* run((db) => db.query.postRecord.findFirst({where: {id: input.postId}}));
		if (!meta) {
			return {postId: input.postId, deleted: false, sandboxedAt: null} satisfies RestorePostResult;
		}
		if (meta.authorId !== input.actorId) {
			return yield* new UnauthorizedPostMutation({
				postId: input.postId,
				message: `not authorized to mutate post ${input.postId}`,
			});
		}
		const lifecycle = Removal.fromColumns(meta);
		if (!Removal.isRemoved(lifecycle)) {
			return {postId: input.postId, deleted: false, sandboxedAt: null} satisfies RestorePostResult;
		}

		const now = new Date();
		// Sandbox-faithful restore (#1811): `restore` returns `Sandboxed` iff the row
		// was sandboxed before deletion. The persisted columns carry the marker, and
		// the returned `sandboxedAt` drives the mutation's broadcast decision.
		const restored = Removal.restore(lifecycle);
		const live = Removal.toColumns(restored);
		yield* Removal.restoreEntity(
			removalSeq,
			{kind: "post", id: input.postId, title: meta.title},
			live,
			now,
		);

		yield* persistPanoStats(now);

		return {
			postId: input.postId,
			deleted: true,
			sandboxedAt: live.sandboxedAt,
		} satisfies RestorePostResult;
	});

	const moderateRemovePost = Effect.fn("Pano.moderateRemovePost")(function* (input: {
		postId: string;
		resolverId: string;
		reportId: string;
	}) {
		const meta = yield* run((db) => db.query.postRecord.findFirst({where: {id: input.postId}}));
		if (!meta) return {removed: false};
		const current = Removal.fromColumns(meta);
		if (Removal.isRemoved(current)) {
			return {removed: false};
		}

		const now = new Date();
		const removed = Removal.toColumns(
			Removal.remove({
				removedAt: now,
				removedBy: input.resolverId,
				reason: new Removal.Moderated({reportId: input.reportId}),
				// Preserve the pre-removal sandbox marker so a mod-restore round-trips to
				// the pre-removal state, not Live (#1811). Promotion to Live is the mod
				// `promote` path (#1206), never a restore side effect.
				sandboxedAt: Removal.sandboxedAtOf(current),
			}),
		);
		yield* Removal.removeEntity(removalSeq, {kind: "post", id: input.postId}, removed, now);
		yield* persistPanoStats(now);

		return {removed: true};
	});

	const moderateRestorePost = Effect.fn("Pano.moderateRestorePost")(function* (input: {
		postId: string;
	}) {
		const meta = yield* run((db) => db.query.postRecord.findFirst({where: {id: input.postId}}));
		if (!meta) return {restored: false, sandboxedAt: null};
		const lifecycle = Removal.fromColumns(meta);
		if (!Removal.isRemoved(lifecycle)) return {restored: false, sandboxedAt: null};

		const now = new Date();
		const live = Removal.toColumns(Removal.restore(lifecycle));
		yield* Removal.restoreEntity(
			removalSeq,
			{kind: "post", id: input.postId, title: meta.title},
			live,
			now,
		);
		yield* persistPanoStats(now);

		// The round-tripped sandbox marker (#1811): a çaylak's post restores to Sandboxed,
		// so report's live re-append gates the public-feed broadcast on it.
		return {restored: true, sandboxedAt: live.sandboxedAt};
	});

	/**
	 * Shared body for `voteOnPost` / `retractPostVote`. Delegates to
	 * `Vote.cast` and translates `VoteTargetNotFound` into `PostNotFound`.
	 */
	const applyPostVote = Effect.fn("Pano.applyPostVote")(function* (
		input: VoteOnPostInput,
		isVote: boolean,
	) {
		const meta = yield* run((db) =>
			db.query.postRecord.findFirst({
				where: {id: input.postId, removedAt: {isNull: true}},
			}),
		);
		if (!meta) {
			return yield* new PostNotFound({
				postId: input.postId,
				message: `post ${input.postId} not found`,
			});
		}

		const voteResult = yield* voteSvc
			.cast({
				userId: input.voterId,
				targetKind: "post",
				targetId: input.postId,
				value: isVote,
			})
			.pipe(
				translateVoteMiss(
					() => new PostNotFound({postId: input.postId, message: `post ${input.postId} not found`}),
				),
			);

		const now = new Date();
		// Vote.cast wrote score + hot_score inside its batch; re-read for the
		// converged values.
		const refreshed = voteResult.changed
			? yield* run((db) => db.query.postRecord.findFirst({where: {id: input.postId}}))
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
		} satisfies VoteOnPostResult;
	});

	const voteOnPost = Effect.fn("Pano.voteOnPost")(function* (input: VoteOnPostInput) {
		return yield* applyPostVote(input, true);
	});

	// Reaction delegation — the karma-free, ungated twin of `voteOnPost` (#1863).
	// Delegates the write to `Reaction.react` (kind `post`), translates the internal
	// `ReactionTargetNotFound` into the wire-facing `PostNotFound` (the vote path's
	// `translateVoteMiss` analogue), then RE-RESOLVES the post via the same batched
	// `getPostsByIds` read as `post.save` so the returned entity carries the fresh
	// `reactions` aggregate + `myReaction`. Unlike `voteOnPost` there is NO tier arm
	// (`VoterNotEligible`) and NO karma path: a çaylak may react, and nothing writes
	// karma — the settled ungated/social-only model (epic #1840, ADR-referenced).
	const reactToPost = Effect.fn("Pano.reactToPost")(function* (input: ReactToPostInput) {
		const result = yield* reactionSvc
			.react({
				userId: input.userId,
				targetKind: "post",
				targetId: input.postId,
				emoji: input.emoji,
			})
			.pipe(
				Effect.catchTag(
					"reaction/ReactionTargetNotFound",
					(_: ReactionTargetNotFound) =>
						new PostNotFound({
							postId: input.postId,
							message: `post ${input.postId} not found`,
						}),
				),
			);

		// Re-resolve like a read so the echoed entity carries the freshly-stamped
		// `reactions` aggregate (counts + the viewer's own `myReaction`). The react
		// write already asserted the target is live, so a missing row here is a raced
		// removal — surface it as `PostNotFound`, same as `post.save`.
		const [row] = yield* getPostsByIds([input.postId], {viewerId: input.userId});
		if (!row) {
			return yield* new PostNotFound({
				postId: input.postId,
				message: `post ${input.postId} not found`,
			});
		}
		return {post: row, changed: result.changed} satisfies ReactToPostResult;
	});

	const retractPostVote = Effect.fn("Pano.retractPostVote")(function* (input: VoteOnPostInput) {
		// The shared body's channel carries `VoterNotEligible` because `Vote.cast`'s type
		// does — but the tier gate fires on the CAST direction only (`value: true`), so a
		// retraction (`value: false`) can never raise it. Die if it somehow does (a broken
		// invariant, not a user-facing case), keeping this method's error channel to
		// `PostNotFound`.
		return yield* applyPostVote(input, false).pipe(
			Effect.catchTag("vote/VoterNotEligible", (e) => Effect.die(e)),
		);
	});

	return {
		getPost,
		listPostsConnection,
		getPostsByIds,
		listSandboxedPosts,
		submitPost,
		saveDraft,
		discardDraft,
		editPost,
		deletePost,
		restorePost,
		moderateRemovePost,
		moderateRestorePost,
		voteOnPost,
		retractPostVote,
		reactToPost,
	};
};
