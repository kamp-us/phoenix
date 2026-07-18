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
	authorId: UserId;
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
	authorId: UserId;
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
 * absent URL yields `{host: null, urlNormalized: null}`; a malformed URL OR one
 * whose scheme isn't `http(s)` fails `UrlInvalid`. Shared by `submitPost` and
 * `saveDraft`.
 *
 * The `http(s)`-only allowlist (via {@link isHttpUrl}) is defense-in-depth at the
 * PERSISTENCE layer: it keeps a `javascript:`/`data:`/`file:` URL from ever
 * reaching `post_record.url`, closing a stored-invariant gap so no consumer —
 * present or future, React or not — can ever read a non-http(s) href back out
 * (#1890). The bare-`new URL()` guard here previously admitted them.
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
	/** Batched live author-identity reader (`Pasaport.getProfileIdentitiesByIds`, #2139). */
	readonly readProfileIdentities: ReadProfileIdentities;
}

/**
 * Max live-non-draft rows a single decay SELECT materializes before the sweep advances
 * its keyset cursor (#2559). Bounds the isolate's per-query working set so a growing table
 * never loads an unbounded result set into memory in one shot — the sweep still visits
 * EVERY post each tick (windowless, #2133), just in id-ordered pages. Sized well above the
 * v1 cohort's tens-of-posts so today's pass is a single short page (no behavior change at
 * current scale) while the bound holds as the table grows; a named constant, tunable.
 */
export const HOT_SCORE_DECAY_CHUNK = 200;

/**
 * The DB seam the chunked decay sweep drives, factored out so {@link scanDecayChunks}'s
 * cursor-advance + full-coverage (windowless) logic is unit-testable with in-memory ports
 * — no D1, mirroring the pure/`decayHotScores` split. `fetchChunk(afterId, limit)` returns
 * up to `limit` live-non-draft rows with `id > afterId` in ascending id order (`afterId`
 * `null` ⇒ from the head); `writeBack` persists the changed `hot_score`s of one page.
 */
export interface HotDecayScanPorts {
	readonly fetchChunk: (
		afterId: string | null,
		limit: number,
	) => Effect.Effect<ReadonlyArray<HotDecayRow>>;
	readonly writeBack: (updates: ReadonlyArray<HotDecayUpdate>) => Effect.Effect<void>;
}

/**
 * Keyset-chunk the windowless decay sweep: page id-ordered slices of at most `chunkSize`
 * rows, decaying + writing back each page before fetching the next, so no single query
 * scans the whole table in one shot (#2559). The sweep still covers every live non-draft
 * post per call — chunking is a mechanical batching of the same full pass, NOT a recency
 * window (#2133): the id-keyset cursor only bounds each page, it never excludes a post by
 * age. Loops until a short (`< chunkSize`) page marks the tail; an exact-multiple table
 * takes one extra empty page to terminate. Returns the pass's scanned/updated totals.
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
			// Nothing changed ⇒ no write (the common steady state) — writeBack is skipped, not
			// called with an empty batch.
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
 * The periodic sıcak/hot decay-refresh (#2027, WINDOWLESS since #2133, keyset-chunked in
 * #2559), factored to the ONE dep it reads (`run`) so it builds standalone. `hot_score` is
 * a stored, keyset-read column written only at activity sites, so an inactive post's age
 * term freezes and it squats the hot feed. This re-decays the stored column on a schedule
 * (the cron trigger in `index.ts`) so ranking keeps decaying with age WITHOUT a read-time
 * recompute — the READ-PATH keyset-cursor contract and the no-`POW` constraint both need
 * `hot_score` to stay a stored, indexed, monotonic-per-snapshot column. Scoped only to
 * live, non-draft posts (a removed post's `hot_score` is already zeroed by the removal
 * batch); the pure decision (formula reuse + changed-only filter) lives in
 * `db/hotScoreDecay.ts`, and the chunk-sweep control flow in {@link scanDecayChunks}.
 *
 * WINDOWLESS (#2133): earlier this pass scanned only a 72h recency window, so a post that
 * froze high and drifted past 72h was never re-selected and squatted the feed forever (the
 * ~18-day, hot_score=285 post the founder observed). Every live non-draft post is now
 * re-decayed each pass, so age keeps eroding rank at any age.
 *
 * KEYSET-CHUNKED SCAN (#2559): the sweep is bounded by an ascending-id keyset cursor into
 * `HOT_SCORE_DECAY_CHUNK`-sized pages rather than one unbounded SELECT, so the isolate
 * never materializes the whole table at once. The chunking is a WRITE/SCAN-path bound and
 * is distinct from the read-path feed pagination above — it does NOT reintroduce a window:
 * the cursor pages through EVERY post each tick, preserving #2133.
 *
 * Exported (not inlined in `makePostOperations`) so the AC4 integration test can drive the
 * SHIPPED method against real remote D1 built from just a `run` — no full
 * `PostOperationsDeps` graph, no re-implementation of the query.
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
			// One UPDATE per changed row of the page, all in the caller's single clock reading.
			// `Effect.forEach` sequences them.
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
		// Mute read-mask (#3113): a muted author's post reads as not-found for the
		// muter, the in-memory dual of the feed's `mutedAuthorsWhere` SQL arm.
		if (isMutedAuthor(meta.authorId, opts.mutedIds)) return null;
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
		// Filter the çaylak sandbox (#1205) for this viewer at the same layer.
		const sandboxClause = sandboxVisibleWhere(
			{sandboxedAt: schema.postRecord.sandboxedAt, authorId: schema.postRecord.authorId},
			resolveSandboxViewer(opts),
		);
		if (sandboxClause) baseConditions.push(sandboxClause);
		// Mute read-mask (#3113): hide muted authors' posts from the muter's feed.
		const muteClause = mutedAuthorsWhere(schema.postRecord.authorId, opts.mutedIds);
		if (muteClause) baseConditions.push(muteClause);

		type CursorRow = {
			id: string;
			score: number;
			hotScore: number;
			commentCount: number;
			createdAt: Date | null;
		};

		// The total count and the keyset page are INDEPENDENT reads over the same
		// base predicate — the page query never consumes the count — so they run
		// concurrently instead of serially, collapsing two cross-region D1
		// round-trips into one overlapped batch and cutting the feed's latency floor
		// (#2275). The combinator is the repo's `Effect.all([...], {concurrency:
		// "unbounded"})` parallel-reads idiom (Divan.collect). NOT folded into a
		// single `count(*) OVER()` window: the keyset query's WHERE carries the
		// cursor predicate (`id < cursor`), so a window count there would total only
		// the post-cursor slice, not the whole feed — a different result the fold is
		// forbidden to change. Per-viewer scalars (myVote/isSaved) + reaction
		// aggregates are NOT read here; they come from the batched `getPostsByIds`
		// re-hydrate in the resolver, left untouched.
		const countEffect = run((db) =>
			db
				.select({n: sql<number>`count(*)`})
				.from(schema.postRecord)
				.where(and(...baseConditions))
				.get()
				.then((r) => r?.n ?? 0),
		);

		// The keyset page path: resolve the cursor (a DB read only when `after` is
		// present), short-circuit to `null` on a cursor miss (the caller renders the
		// empty page), else fetch the page and stamp the live author identity.
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

			// Route the keyset projection through the same `post-fields.ts` column→field
			// map the by-id path uses, so `body` collapses to `null` for an empty excerpt
			// (not `""`) — the divergence is unrepresentable, not hand-synced (#1170).
			const page = forwardPage(fetched, first, (r) => r.id, toPostSummaryKeysetRow);

			// Stamp the LIVE author identity onto the page — one batched
			// `getProfileIdentitiesByIds` read for the whole page (never per-row), the same
			// idiom `getPostsByIds` uses. This is the feed's convergence point: the resolver
			// paths that serve this page WITHOUT re-hydrating through `getPostsByIds` —
			// `landingPosts` (always anon) and the signed-OUT `posts` feed — would otherwise
			// render the write-time `authorName` snapshot and degrade to `@username` (#2151,
			// the last unstamped pano read path from #2139's `stampAuthorIdentity` rollout).
			const stampedRows = yield* stampAuthorIdentity(readProfileIdentities, page.rows);
			return {...page, rows: stampedRows};
		});

		// `countEffect` is element 0 so its read is issued first — the parallelized
		// reads are order-independent for correctness (each is fully consumed), but
		// keeping count first preserves the deterministic call order the scripted
		// unit doubles replay against (count, [cursor], fetch).
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
						// Mute read-mask (#3113): drop muted authors' posts from the muter's batch.
						mutedAuthorsWhere(schema.postRecord.authorId, opts.mutedIds),
					),
				),
		);
		// `myVote`/`isSaved` are the viewer scalars, finalized via `stampViewerScalars`
		// (one `user_vote` + one `post_bookmark` read for the whole batch); the row's
		// intrinsic fields come from the `post-fields.ts` column→field map. The
		// draft/ownership gate is enforced in SQL by `postVisibleWhere` above — a draft
		// the viewer doesn't own never reaches this batch — so a surviving `isDraft` row
		// is the author's own: read-your-writes, now verified rather than assumed.
		// `sandboxed` is the owner-scoped in-review flag (#2200): computed off the fetched
		// record (`sandboxed_at` + `author_id`) against the viewer, so it lands `true` only
		// for the author's own still-in-review post and never leaks to another viewer.
		const intrinsic = fetched.map((p) => ({
			...toPostSummaryRow(p),
			sandboxed: ownSandboxed(p, viewerId),
		}));
		const scalared = yield* stampViewerScalars(intrinsic, viewerId, postViewerScalars);
		const reacted = yield* stampReactionAggregate(reactionSvc, "post", scalared, viewerId);
		return yield* stampAuthorIdentity(readProfileIdentities, reacted);
	});

	// The viewer overlay (#2322, epic #2316 leg B): given the base feed's post ids,
	// return ONLY the per-viewer scalars (`myVote`/`isSaved`) — the exact slice the
	// GET-able base projection omits so it can be viewer-invariant + cacheable. Reuses
	// the SAME `postViewerScalars` batch readers as `getPostsByIds` (one `user_vote` +
	// one `post_bookmark` `IN (...)` read for the whole id batch, never per-row), so the
	// split adds no N+1. It reads no `post_record` at all — presence is a property of
	// the viewer's own vote/bookmark rows, so an id the viewer never touched degrades to
	// `false` (or `null` for an anonymous viewer, the read-path convention). Nothing here
	// is viewer-cross-visible: a reader only ever learns its OWN vote/save state.
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

		// The post row committed in the batch above; its stats refresh is a recomputable
		// cache, so swallow-and-log a die rather than 500 the mutation and provoke a retry
		// that mints a duplicate row (#2556, the create-path twin of #2012).
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

		// The round-tripped sandbox marker (#1811): a çaylak's post restores to Sandboxed,
		// so report's live re-append gates the public-feed broadcast on it.
		return {restored: true, sandboxedAt: outcome.sandboxedAt};
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
