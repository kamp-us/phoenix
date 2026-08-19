/**
 * Pano's posts plane — post CRUD, drafts, vote/reaction delegation, the moderator
 * soft-delete/restore pair, and the connection-shaped feed/by-id reads. Validation
 * lives in the service methods, not resolvers (ADR 0013).
 */
import {id} from "@usirin/forge";
import {and, asc, desc, eq, gt, inArray, isNull, sql} from "drizzle-orm";
import {Effect} from "effect";
import {POST_SORT_LEAD_COLUMN, type PostSort} from "../../../src/lib/panoFeedSort.ts";
import {isPostTagKind} from "../../../src/lib/panoTags.ts";
import type {DrizzleAccessOrDie} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {computeHotScore} from "../../db/hotScore.ts";
import {decayHotScores, type HotDecayRow, type HotDecayUpdate} from "../../db/hotScoreDecay.ts";
import {emptyKeysetPage, forwardPage, keysetAfter, resolveCursor} from "../../db/keyset.ts";
import type {ReactionEmoji} from "../../db/reaction-emoji.ts";
import type {UserId} from "../../lib/ids.ts";
import {type ReadProfileIdentities, stampAuthorIdentity} from "../fate/author-identity.ts";
import {stampReactionAggregate} from "../fate/reaction-aggregate.ts";
import {stampViewerScalars} from "../fate/viewer-scalars.ts";
import {applyRemovalTransition, swallowRefresh} from "../lifecycle/apply-removal-transition.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import * as Removal from "../lifecycle/removal.ts";
import {
	ownSandboxed,
	resolveSandboxViewer,
	sandboxBacklogWhere,
	sandboxVisibleWhere,
} from "../lifecycle/SandboxVisibility.ts";
import {isMutedAuthor, mutedAuthorsWhere} from "../mute/read-mask.ts";
import type {ReactionTargetNotFound} from "../reaction/errors.ts";
import type {Reaction} from "../reaction/Reaction.ts";
import type {ReportId} from "../report/ids.ts";
import {syncPostSearch} from "../search/fts-sync.ts";
import {SelfVoteNotAllowed} from "../vote/errors.ts";
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
import type {PostId} from "./ids.ts";
import {isHttpUrl} from "./link-metadata.ts";
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

export interface PostTagInput {
	kind: string;
	label?: string | undefined;
}

export interface SubmitPostInput {
	title: string;
	url?: string | undefined;
	body?: string | undefined;
	tags: ReadonlyArray<{kind: string; label?: string | undefined}>;
	authorId: UserId;
	authorName: string;
	/** Decided by the resolver from authorship + author tier (#1205); `null`/absent ⇒ posted live. */
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
	authorId: UserId;
	authorName: string;
	title?: string | undefined;
	url?: string | undefined;
	body?: string | undefined;
	tags?: ReadonlyArray<{kind: string; label?: string | undefined}> | undefined;
}

export interface SaveDraftResult extends SubmitPostResult {
	isDraft: true;
}

export interface DiscardDraftInput {
	authorId: UserId;
}

export interface DiscardDraftResult {
	postId: string | null;
}

export interface VoteOnPostInput {
	postId: PostId;
	voterId: UserId;
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
	postId: PostId;
	userId: UserId;
	/** Sets/changes the user's single reaction; `null` retracts it. */
	emoji: ReactionEmoji | null;
}

/** `changed` is the idempotency signal: a re-react of the same emoji, or a retract-when-none, is `false`. */
export interface ReactToPostResult {
	post: PostSummaryRow;
	changed: boolean;
}

export interface EditPostInput {
	postId: PostId;
	actorId: UserId;
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
	postId: PostId;
	actorId: UserId;
	/** Why the post is removed (ADR 0096). Defaults to `AuthorDeletion`. */
	reason?: Removal.RemovalReason;
}

export interface DeletePostResult {
	postId: string;
	deleted: boolean;
}

/**
 * `sandboxedAt` drives the live-broadcast decision (#1811): `null` ⇒ restored to `Live`,
 * non-null ⇒ restored to the çaylak sandbox and the mutation must suppress the live echo
 * through `decidePublish`. Never broadcast a sandboxed restore to a public topic.
 */
export interface RestorePostResult {
	postId: string;
	deleted: boolean;
	sandboxedAt: Date | null;
}

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

/** A draft has no required title (a half-filled form persists), only the length cap. */
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
 * The `http(s)`-only allowlist (via {@link isHttpUrl}) is defense-in-depth at the
 * persistence layer: it keeps a `javascript:`/`data:`/`file:` URL from ever reaching
 * `post_record.url`, so no consumer can read a non-http(s) href back out (#1890). A
 * bare `new URL()` guard admits them.
 */
const parseSubmitUrl = Effect.fn("Pano.parseSubmitUrl")(function* (url: string | null | undefined) {
	if (url == null || url.length === 0) {
		return {host: null, urlNormalized: null} as const;
	}
	const parsed = isHttpUrl(url);
	if (!parsed) {
		return yield* new UrlInvalid({message: "URL geçersiz"});
	}
	return {host: parsed.host, urlNormalized: parsed.toString()} as const;
});

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

/** Unlike submit, a draft's tags are optional — an empty kind is skipped, not rejected. */
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

export interface PostOperationsDeps {
	readonly run: DrizzleAccessOrDie["run"];
	readonly batch: DrizzleAccessOrDie["batch"];
	readonly voteSvc: typeof Vote.Service;
	readonly bookmarkSvc: typeof Bookmark.Service;
	readonly reactionSvc: typeof Reaction.Service;
	readonly removalSeq: Removal.RemovalSequence;
	readonly persistPanoStats: PersistPanoStats;
	readonly readProfileIdentities: ReadProfileIdentities;
}

/**
 * Bounds one decay SELECT's working set (#2559). Paging is NOT a recency window — the
 * sweep still visits every live non-draft post each tick (#2133).
 */
export const HOT_SCORE_DECAY_CHUNK = 200;

/** `fetchChunk` returns live non-draft rows with `id > afterId` ascending (`null` ⇒ from the head). */
export interface HotDecayScanPorts {
	readonly fetchChunk: (
		afterId: string | null,
		limit: number,
	) => Effect.Effect<ReadonlyArray<HotDecayRow>>;
	readonly writeBack: (updates: ReadonlyArray<HotDecayUpdate>) => Effect.Effect<void>;
}

/**
 * The id-keyset cursor bounds each page only — it never excludes a post by age, so this
 * covers every live non-draft post per call (#2133) while no single query scans the whole
 * table (#2559).
 */
export const scanDecayChunks = (
	ports: HotDecayScanPorts,
	nowMs: number,
	chunkSize: number,
): Effect.Effect<{scanned: number; updated: number}> =>
	Effect.gen(function* () {
		let after: string | null = null;
		let scanned = 0;
		let updated = 0;
		for (;;) {
			const rows: ReadonlyArray<HotDecayRow> = yield* ports.fetchChunk(after, chunkSize);
			if (rows.length === 0) break;
			scanned += rows.length;
			const updates = decayHotScores(rows, nowMs);
			if (updates.length > 0) {
				yield* ports.writeBack(updates);
				updated += updates.length;
			}
			const last = rows[rows.length - 1];
			if (rows.length < chunkSize || !last) break;
			after = last.id;
		}
		return {scanned, updated};
	});

/**
 * The periodic sıcak/hot decay-refresh (#2027), driven by the cron trigger in `index.ts`.
 * `hot_score` is a stored, keyset-read column written only at activity sites, so an
 * inactive post's age term freezes and it squats the hot feed; the read-path keyset
 * contract and the no-`POW` constraint both need it to stay stored, so it is re-decayed
 * on a schedule rather than at read time. Windowless since #2133 — an earlier 72h window
 * left a frozen-high post squatting the feed forever. Exported so the integration test can
 * drive the shipped method off just a `run`.
 */
export const makeRefreshHotScores = (run: DrizzleAccessOrDie["run"]) =>
	Effect.fn("Pano.refreshHotScores")(function* (now: Date) {
		const ports: HotDecayScanPorts = {
			fetchChunk: (afterId, limit) =>
				run((db) =>
					db
						.select({
							id: schema.postRecord.id,
							score: schema.postRecord.score,
							hotScore: schema.postRecord.hotScore,
							createdAt: schema.postRecord.createdAt,
						})
						.from(schema.postRecord)
						.where(
							and(
								isNull(schema.postRecord.removedAt),
								sql`${schema.postRecord.isDraft} is not 1`,
								afterId === null ? undefined : gt(schema.postRecord.id, afterId),
							),
						)
						.orderBy(asc(schema.postRecord.id))
						.limit(limit),
				).pipe(
					Effect.map(
						(
							rows: ReadonlyArray<{
								id: string;
								score: number;
								hotScore: number;
								createdAt: Date | null;
							}>,
						): ReadonlyArray<HotDecayRow> =>
							rows.map((r) => ({
								id: r.id,
								score: r.score,
								hotScore: r.hotScore,
								createdAtMs: (r.createdAt ?? now).getTime(),
							})),
					),
				),
			writeBack: (updates) =>
				Effect.forEach(
					updates,
					(u) =>
						run((db) =>
							db
								.update(schema.postRecord)
								.set({hotScore: u.hotScore})
								.where(eq(schema.postRecord.id, u.id)),
						),
					{concurrency: 1, discard: true},
				),
		};
		return yield* scanDecayChunks(ports, now.getTime(), HOT_SCORE_DECAY_CHUNK);
	});

export const makePostOperations = (deps: PostOperationsDeps) => {
	const {
		run,
		batch,
		voteSvc,
		bookmarkSvc,
		reactionSvc,
		removalSeq,
		persistPanoStats,
		readProfileIdentities,
	} = deps;

	// Every read finalizes through `stampViewerScalars` with these specs — one `IN (...)`
	// read per scalar for the whole batch, never a per-row N+1 (#1126).
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
		opts: {
			viewerId?: string | null | undefined;
			sandboxViewer?: SandboxViewer | undefined;
			mutedIds?: ReadonlySet<string> | undefined;
		} = {},
	) {
		const meta = yield* run((db) =>
			db.query.postRecord.findFirst({
				where: {id: postId, removedAt: {isNull: true}},
			}),
		);
		if (!meta) return null;
		if (isMutedAuthor(meta.authorId, opts.mutedIds)) return null;
		// The in-memory mirror of the SQL `postVisibleWhere` the batch read uses (ADR 0113),
		// because this single-row read goes through the relational query builder.
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
			mutedIds?: ReadonlySet<string> | undefined;
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
		const sandboxClause = sandboxVisibleWhere(
			{sandboxedAt: schema.postRecord.sandboxedAt, authorId: schema.postRecord.authorId},
			resolveSandboxViewer(opts),
		);
		if (sandboxClause) baseConditions.push(sandboxClause);
		const muteClause = mutedAuthorsWhere(schema.postRecord.authorId, opts.mutedIds);
		if (muteClause) baseConditions.push(muteClause);

		type CursorRow = {
			id: string;
			score: number;
			hotScore: number;
			commentCount: number;
			createdAt: Date | null;
		};

		// Do NOT fold this into a `count(*) OVER()` window on the keyset query: that WHERE
		// carries the cursor predicate (`id < cursor`), so the window would count only the
		// post-cursor slice, not the whole feed (#2275).
		const countEffect = run((db) =>
			db
				.select({n: sql<number>`count(*)`})
				.from(schema.postRecord)
				.where(and(...baseConditions))
				.get()
				.then((r) => r?.n ?? 0),
		);

		const pageEffect = Effect.gen(function* () {
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
			if (cursor.kind === "miss") return null;
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

			// The cursor predicate and `orderBy` derive from one map so they cannot drift apart.
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

			const orderBy = [
				...(leadColumn ? [desc(leadColumn.column)] : []),
				desc(schema.postRecord.id),
			];

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

			const page = forwardPage(fetched, first, (r) => r.id, toPostSummaryKeysetRow);

			// Without this, the paths that serve the page without re-hydrating through
			// `getPostsByIds` (`landingPosts`, the signed-out `posts` feed) render the
			// write-time `authorName` snapshot and degrade to `@username` (#2151).
			const stampedRows = yield* stampAuthorIdentity(readProfileIdentities, page.rows);
			return {...page, rows: stampedRows};
		});

		// `countEffect` stays element 0: correctness is order-independent, but the scripted
		// unit doubles replay against the call order (count, [cursor], fetch).
		const [totalCount, pageResult] = yield* Effect.all([countEffect, pageEffect], {
			concurrency: "unbounded",
		});
		if (pageResult === null) {
			return {...emptyKeysetPage, totalCount} satisfies PostConnectionPage;
		}
		return {...pageResult, totalCount} satisfies PostConnectionPage;
	});

	const getPostsByIds = Effect.fn("Pano.getPostsByIds")(function* (
		ids: ReadonlyArray<string>,
		opts: {
			viewerId?: string | null | undefined;
			sandboxViewer?: SandboxViewer | undefined;
			mutedIds?: ReadonlySet<string> | undefined;
		} = {},
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
						mutedAuthorsWhere(schema.postRecord.authorId, opts.mutedIds),
					),
				),
		);
		// `sandboxed` is owner-scoped (#2200): it lands `true` only for the author's own
		// still-in-review post and must never leak to another viewer.
		const intrinsic = fetched.map((p) => ({
			...toPostSummaryRow(p),
			sandboxed: ownSandboxed(p, viewerId),
		}));
		const scalared = yield* stampViewerScalars(intrinsic, viewerId, postViewerScalars);
		const reacted = yield* stampReactionAggregate(reactionSvc, "post", scalared, viewerId);
		return yield* stampAuthorIdentity(readProfileIdentities, reacted);
	});

	// The per-viewer slice the GET-able base projection omits so it can stay
	// viewer-invariant + cacheable (#2322). Reads no `post_record` at all, so a reader only
	// ever learns its OWN vote/save state.
	const readViewerOverlay = Effect.fn("Pano.readViewerOverlay")(function* (
		ids: ReadonlyArray<string>,
		opts: {viewerId?: string | null | undefined} = {},
	) {
		if (ids.length === 0) return [];
		const viewerId = opts.viewerId ?? null;
		const stamped = yield* stampViewerScalars(
			ids.map((id) => ({id})),
			viewerId,
			postViewerScalars,
		);
		return stamped.map((row) => ({id: row.id, myVote: row.myVote, isSaved: row.isSaved}));
	});

	// The moderator sandbox-queue read model (#1205). Authority is gated at the resolver;
	// this service read is unconditional.
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

		// Insert + FTS dual-write in ONE batch: all-or-none, so a crash mid-write can't
		// orphan a `post_search` row (the ADR 0080 lockstep invariant).
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

		// The row is already committed and the stats refresh is a recomputable cache, so a
		// die is swallowed rather than 500ing the mutation into a duplicate-minting retry
		// (#2556).
		yield* swallowRefresh("Pano.submitPost", persistPanoStats(now));

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

	// One draft per author, enforced by the partial unique index + this probe-then-upsert.
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

		// No `syncPostSearch` and no `recomputePanoStats` on purpose: both are public-surface
		// bookkeeping a private draft must not touch.

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

		// Update + FTS re-sync in ONE batch so they move all-or-none (ADR 0080). The body is
		// out of v1 search scope, so a body-only edit leaves the FTS row untouched.
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

	// SOFT delete onto the ADR 0096 substrate. Votes are wiped but karma is KEPT — the pano
	// karma-reversal is deleted, not forgotten.
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

		const now = new Date();
		const outcome = yield* applyRemovalTransition({
			label: "Pano.deletePost",
			transition: "remove",
			seq: removalSeq,
			subject: meta,
			target: {kind: "post", id: input.postId},
			removedBy: input.actorId,
			reason: input.reason ?? new Removal.AuthorDeletion(),
			now,
			refresh: persistPanoStats(now),
		});

		return {postId: input.postId, deleted: outcome.committed} satisfies DeletePostResult;
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

		const now = new Date();
		const outcome = yield* applyRemovalTransition({
			label: "Pano.restorePost",
			transition: "restore",
			seq: removalSeq,
			subject: meta,
			target: {kind: "post", id: input.postId, title: meta.title},
			now,
			refresh: persistPanoStats(now),
		});
		if (!outcome.committed) {
			return {postId: input.postId, deleted: false, sandboxedAt: null} satisfies RestorePostResult;
		}

		return {
			postId: input.postId,
			deleted: true,
			sandboxedAt: outcome.sandboxedAt,
		} satisfies RestorePostResult;
	});

	const moderateRemovePost = Effect.fn("Pano.moderateRemovePost")(function* (input: {
		postId: string;
		resolverId: string;
		reportId: ReportId;
	}) {
		const meta = yield* run((db) => db.query.postRecord.findFirst({where: {id: input.postId}}));
		if (!meta) return {removed: false};

		const now = new Date();
		const outcome = yield* applyRemovalTransition({
			label: "Pano.moderateRemovePost",
			transition: "remove",
			seq: removalSeq,
			subject: meta,
			target: {kind: "post", id: input.postId},
			removedBy: input.resolverId,
			reason: new Removal.Moderated({reportId: input.reportId}),
			now,
			refresh: persistPanoStats(now),
		});

		return {removed: outcome.committed};
	});

	const moderateRestorePost = Effect.fn("Pano.moderateRestorePost")(function* (input: {
		postId: string;
	}) {
		const meta = yield* run((db) => db.query.postRecord.findFirst({where: {id: input.postId}}));
		if (!meta) return {restored: false, sandboxedAt: null};

		const now = new Date();
		const outcome = yield* applyRemovalTransition({
			label: "Pano.moderateRestorePost",
			transition: "restore",
			seq: removalSeq,
			subject: meta,
			target: {kind: "post", id: input.postId, title: meta.title},
			now,
			refresh: persistPanoStats(now),
		});
		if (!outcome.committed) return {restored: false, sandboxedAt: null};

		// A çaylak's post restores to Sandboxed, so report's live re-append gates the
		// public-feed broadcast on this marker (#1811).
		return {restored: true, sandboxedAt: outcome.sandboxedAt};
	});

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

		// Self-vote guard (#2216, founder-ruled): a cast on one's OWN post is rejected
		// at the domain, so an inflated self-score is unrepresentable rather than caught
		// downstream. Cast-only (mirrors the `VoterNotEligible` tier gate) — a retraction
		// is exempt because a blocked cast leaves nothing to retract.
		if (isVote && meta.authorId === input.voterId) {
			return yield* new SelfVoteNotAllowed({
				voterId: input.voterId,
				message: "kendi gönderine oy veremezsin",
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

	// The karma-free, ungated twin of `voteOnPost` (#1863). Unlike voting there is NO tier
	// arm and NO karma path on purpose: a çaylak may react, and nothing writes karma — the
	// settled ungated/social-only model (epic #1840).
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

		// The react write already asserted the target is live, so a missing row here is a
		// raced removal, not a bad input.
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
		// The shared body's channel carries `VoterNotEligible` + `SelfVoteNotAllowed` because
		// `applyPostVote`'s type does — but both fire on the CAST direction only (`isVote`/
		// `value: true`), so a retraction (`value: false`) can never raise them. Die if one
		// somehow does (a broken invariant, not a user-facing case), keeping this method's
		// error channel to `PostNotFound`.
		return yield* applyPostVote(input, false).pipe(
			Effect.catchTags({
				"vote/VoterNotEligible": (e) => Effect.die(e),
				"vote/SelfVoteNotAllowed": (e) => Effect.die(e),
			}),
		);
	});

	const refreshHotScores = makeRefreshHotScores(run);

	return {
		getPost,
		listPostsConnection,
		getPostsByIds,
		readViewerOverlay,
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
		refreshHotScores,
	};
};
