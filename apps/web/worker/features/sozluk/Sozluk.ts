/**
 * Sozluk — the dictionary feature service: term reads + definition CRUD +
 * connection-shaped pagination. See ADR 0013 / 0082.
 */
import {id} from "@usirin/forge";
import {and, asc, desc, eq, gt, inArray, isNull, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {emptyKeysetPage, forwardPage, keysetAfter, resolveCursor} from "../../db/keyset.ts";
import {keysetKeys, orderByColumns} from "../../db/ordering.ts";
import type {ReactionEmoji} from "../../db/reaction-emoji.ts";
import type {DefinitionId, TermSlug, UserId} from "../../lib/ids.ts";
import {stampAuthorIdentity} from "../fate/author-identity.ts";
import {stampReactionAggregate} from "../fate/reaction-aggregate.ts";
import {parallelStampWave} from "../fate/stamp-wave.ts";
import {stampViewerScalars} from "../fate/viewer-scalars.ts";
import {applyRemovalTransition, swallowRefresh} from "../lifecycle/apply-removal-transition.ts";
import {anonymousViewer, type SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import * as Removal from "../lifecycle/removal.ts";
import {
	ownSandboxed,
	publicLiveWhere,
	resolveSandboxViewer,
	sandboxBacklogWhere,
	sandboxedInPlace,
	sandboxVisibleWhere,
} from "../lifecycle/SandboxVisibility.ts";
import {mutedAuthorsWhere} from "../mute/read-mask.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {Reaction} from "../reaction/Reaction.ts";
import type {ReportId} from "../report/ids.ts";
import {syncTermSearch} from "../search/fts-sync.ts";
import {excerpt as excerptText} from "../text/index.ts";
import {SelfVoteNotAllowed, type VoterNotEligible} from "../vote/errors.ts";
import {translateVoteMiss} from "../vote/translate-vote-miss.ts";
import {Vote} from "../vote/Vote.ts";
import {
	type DefinitionConnectionPage,
	type DefinitionRow,
	type TermPage,
	toDefinitionRow,
} from "./definition-fields.ts";
import {
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
} from "./errors.ts";
import {DEFINITION_ORDERING, TERM_SUMMARY_ORDERING, type TermSummarySort} from "./ordering.ts";
import {termHasVisibleDefinitionWhere} from "./TermVisibility.ts";
import {
	type TermConnectionPage,
	type TermSummaryRow,
	termSummaryColumns,
	toTermSummaryRow,
} from "./term-fields.ts";

export type {DefinitionConnectionPage, DefinitionRow, TermPage} from "./definition-fields.ts";
export type {TermConnectionPage, TermSummaryRow} from "./term-fields.ts";

export const DEFINITION_BODY_MAX = 10_000;

/** See ADR 0013 — body validation lives in the domain, not the resolver. */
const validateBody = Effect.fn("Sozluk.validateBody")(function* (body: string | null | undefined) {
	const rawBody = body ?? "";
	if (rawBody.trim().length === 0) {
		return yield* new BodyRequired({message: "tanım boş olamaz"});
	}
	if (rawBody.length > DEFINITION_BODY_MAX) {
		return yield* new BodyTooLong({
			max: DEFINITION_BODY_MAX,
			message: `tanım en fazla ${DEFINITION_BODY_MAX} karakter olabilir`,
		});
	}
	return rawBody;
});

const titleFromSlug = (slug: string): string => slug.replace(/-/g, " ");

const DEFINITION_EXCERPT_LEN = 140;

const excerpt = (body: string): string => excerptText(body, DEFINITION_EXCERPT_LEN);

const earliestCreatedAt = (defs: ReadonlyArray<{createdAt: Date | null}>): Date | null =>
	defs.reduce<Date | null>((acc, d) => {
		const c = d.createdAt;
		if (!c) return acc;
		return acc && acc < c ? acc : c;
	}, null);

const latestEditAt = (
	defs: ReadonlyArray<{createdAt: Date | null; updatedAt: Date | null}>,
): Date | null =>
	defs.reduce<Date | null>((acc, d) => {
		const u = d.updatedAt ?? d.createdAt;
		if (!u) return acc;
		return acc && acc > u ? acc : u;
	}, null);

export interface TermSummaryDefRow {
	id: string;
	body: string;
	bodyExcerpt: string | null;
	score: number;
	createdAt: Date | null;
	updatedAt: Date | null;
}

export interface TermSummary {
	slug: string;
	title: string;
	firstLetter: string;
	definitionCount: number;
	totalScore: number;
	topDefinitionId: string | null;
	excerpt: string | null;
	firstAt: Date;
	lastEditAt: Date;
}

/**
 * `rows` MUST already be in term-page order `(score desc, created_at asc)` so `rows[0]`
 * is the top definition. `now` is the empty-slice fallback for `firstAt` / `lastEditAt`.
 * See ADR 0082.
 */
export const recomputeTermSummary = (
	rows: ReadonlyArray<TermSummaryDefRow>,
	slug: string,
	title: string,
	now: Date,
): TermSummary => {
	const top = rows[0];
	return {
		slug,
		title,
		firstLetter: slug.charAt(0).toLowerCase(),
		definitionCount: rows.length,
		totalScore: rows.reduce((s, d) => s + d.score, 0),
		topDefinitionId: top?.id ?? null,
		excerpt: top ? top.bodyExcerpt || excerpt(top.body) : null,
		firstAt: earliestCreatedAt(rows) ?? now,
		lastEditAt: latestEditAt(rows) ?? now,
	};
};

/** Slug-keyset page width for the reconcile sweep (#2558); mirrors `HOT_SCORE_DECAY_CHUNK`. */
export const SOZLUK_RECONCILE_CHUNK = 200;

export interface TermRef {
	readonly slug: string;
	readonly title: string;
}

/**
 * `fetchChunk(afterSlug, limit)` returns up to `limit` term rows with `slug > afterSlug` in
 * ascending slug order (`null` ⇒ from the head). Factored so {@link scanReconcileChunks} is
 * unit-testable over in-memory ports (ADR 0082).
 */
export interface SozlukReconcileScanPorts {
	readonly fetchChunk: (
		afterSlug: string | null,
		limit: number,
	) => Effect.Effect<ReadonlyArray<TermRef>>;
	readonly refreshTerm: (term: TermRef) => Effect.Effect<void>;
}

/**
 * Page the sweep in slug-keyset chunks so no single query materializes the whole `term_record`
 * table (#2558). Every term is visited each pass; a short (`< chunkSize`) page marks the tail,
 * so an exact-multiple table takes one extra empty page to terminate.
 */
export const scanReconcileChunks = (
	ports: SozlukReconcileScanPorts,
	chunkSize: number,
): Effect.Effect<{scanned: number}> =>
	Effect.gen(function* () {
		let after: string | null = null;
		let scanned = 0;
		for (;;) {
			const rows: ReadonlyArray<TermRef> = yield* ports.fetchChunk(after, chunkSize);
			if (rows.length === 0) break;
			for (const term of rows) {
				yield* ports.refreshTerm(term);
				scanned++;
			}
			const last = rows[rows.length - 1];
			if (rows.length < chunkSize || !last) break;
			after = last.slug;
		}
		return {scanned};
	});

export type ListSort = TermSummarySort;

export interface AddDefinitionInput {
	termSlug: TermSlug;
	authorId: UserId;
	authorName: string;
	body: string;
	/** Falls back to slug-with-spaces. */
	termTitle?: string | undefined;
	/** Çaylak sandbox stamp (#1205), decided by the resolver. `null`/absent ⇒ created live. */
	sandboxedAt?: Date | null | undefined;
}

export interface AddDefinitionResult {
	definitionId: string;
	termCreated: boolean;
	score: number;
	body: string;
	authorId: string;
	authorName: string;
	createdAt: Date;
	updatedAt: Date;
}

// Distinct brands, so transposing them at a call site is a compile error (#2712).
export interface VoteDefinitionInput {
	definitionId: DefinitionId;
	voterId: UserId;
}

export interface VoteDefinitionResult {
	definitionId: string;
	score: number;
	body: string;
	authorId: string;
	authorName: string;
	createdAt: Date;
	updatedAt: Date;
	myVote: boolean;
	/** `true` if the vote-row state changed; `false` on idempotent no-op. */
	changed: boolean;
}

export interface ReactDefinitionInput {
	definitionId: DefinitionId;
	reactorId: UserId;
	/** A palette emoji sets/changes the reactor's single reaction; `null` retracts it. */
	emoji: ReactionEmoji | null;
}

export interface EditDefinitionInput {
	definitionId: DefinitionId;
	actorId: UserId;
	body: string;
}

export interface EditDefinitionResult {
	definitionId: string;
	score: number;
	body: string;
	authorId: string;
	authorName: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface DeleteDefinitionInput {
	definitionId: DefinitionId;
	actorId: UserId;
	/** Why the definition is being removed (ADR 0096). Defaults to `AuthorDeletion`. */
	reason?: Removal.RemovalReason;
}

export interface DeleteDefinitionResult {
	definitionId: string;
	/** `true` if the row was soft-deleted; `false` on idempotent no-op. */
	deleted: boolean;
	/**
	 * On a restore, where the definition landed back (#1811): `null` ⇒ `Live`; non-null ⇒ the
	 * çaylak sandbox, so the mutation suppresses the live echo. Absent on a delete result.
	 */
	sandboxedAt?: Date | null;
}

export class Sozluk extends Context.Service<
	Sozluk,
	{
		readonly getTerm: (
			slug: string,
			opts?: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined},
		) => Effect.Effect<TermPage | null>;

		/**
		 * Keyset page of a term's live definitions in `(score desc, created_at asc, id asc)`
		 * order; the cursor is a definition id.
		 */
		readonly listDefinitionsKeyset: (
			slug: string,
			opts?: {
				first?: number | undefined;
				after?: string | null | undefined;
				viewerId?: string | null | undefined;
				sandboxViewer?: SandboxViewer | undefined;
				/** Mute read-mask (#3113): muted authors' definitions hidden from the muter. */
				mutedIds?: ReadonlySet<string> | undefined;
				/**
				 * Run the page's independent stamps concurrently (#2709). Output is identical
				 * either way — only wall time collapses.
				 */
				parallelStamps?: boolean | undefined;
			},
		) => Effect.Effect<DefinitionConnectionPage>;

		/**
		 * Batched read of definitions by id. Soft-deleted rows skipped; order not guaranteed
		 * (fate re-associates by id).
		 */
		readonly getDefinitionsByIds: (
			ids: ReadonlyArray<string>,
			opts?: {
				viewerId?: string | null | undefined;
				sandboxViewer?: SandboxViewer | undefined;
				/** Mute read-mask (#3113): muted authors' definitions dropped from the batch. */
				mutedIds?: ReadonlySet<string> | undefined;
				/** See {@link listDefinitionsKeyset}'s `parallelStamps` (#2709). */
				parallelStamps?: boolean | undefined;
			},
		) => Effect.Effect<DefinitionRow[]>;

		/**
		 * The moderator sandbox-queue read (#1205/#1206): a çaylak's still-sandboxed,
		 * not-removed definitions. Moderator authority is gated at the resolver; this read
		 * is unconditional.
		 */
		readonly listSandboxedDefinitions: (opts?: {
			authorId?: string | undefined;
		}) => Effect.Effect<DefinitionRow[]>;

		/** Order not guaranteed (fate re-associates by id). */
		readonly getTermSummariesByIds: (
			slugs: ReadonlyArray<string>,
		) => Effect.Effect<TermSummaryRow[]>;

		readonly listTermSummaries: (opts?: {
			sort?: ListSort;
			limit?: number;
		}) => Effect.Effect<TermSummaryRow[]>;

		/**
		 * Viewer-masked: a term surfaces only when the viewer can read at least one of its
		 * definitions (#3724), so a sandbox-only term is never a dead-end page.
		 */
		readonly listTermSummariesConnection: (opts?: {
			sort?: ListSort;
			first?: number;
			after?: string | null;
			viewerId?: string | null | undefined;
			sandboxViewer?: SandboxViewer | undefined;
		}) => Effect.Effect<TermConnectionPage>;

		/**
		 * Public landing terms (#1424), scoped to LIVE content: a term surfaces only via a
		 * not-removed, not-sandboxed definition, so a sandbox-only term never leaks onto the
		 * public front door even when its `term_record` row exists with a zero live count.
		 */
		readonly getLandingTerms: (limit: number) => Effect.Effect<TermSummaryRow[]>;

		readonly lookupDefinitionTermSlug: (definitionId: string) => Effect.Effect<string | null>;

		readonly addDefinition: (
			input: AddDefinitionInput,
		) => Effect.Effect<AddDefinitionResult, BodyRequired | BodyTooLong>;

		readonly editDefinition: (
			input: EditDefinitionInput,
		) => Effect.Effect<
			EditDefinitionResult,
			BodyRequired | BodyTooLong | DefinitionNotFound | UnauthorizedDefinitionMutation
		>;

		readonly deleteDefinition: (
			input: DeleteDefinitionInput,
		) => Effect.Effect<DeleteDefinitionResult, DefinitionNotFound | UnauthorizedDefinitionMutation>;

		/** Un-remove a `Removed` definition (ADR 0096 §4). Votes stay wiped. */
		readonly restoreDefinition: (
			input: DeleteDefinitionInput,
		) => Effect.Effect<DeleteDefinitionResult, DefinitionNotFound | UnauthorizedDefinitionMutation>;

		/**
		 * Moderator soft-delete (ADR 0098 §6) — gated on a `Moderate` grant, not author
		 * ownership. A missing target is a no-op (`removed: false`), so resolving a stale
		 * report can't fail.
		 */
		readonly moderateRemoveDefinition: (input: {
			definitionId: string;
			resolverId: string;
			reportId: ReportId;
		}) => Effect.Effect<{removed: boolean}>;

		/**
		 * Moderator restore (ADR 0098 §3). `sandboxedAt` round-trips the sandbox marker
		 * (#1811) so a sandboxed restore stays suppressed on the live broadcast.
		 */
		readonly moderateRestoreDefinition: (input: {
			definitionId: string;
		}) => Effect.Effect<{restored: boolean; sandboxedAt: Date | null}>;

		// `VoterNotEligible` (#1810) and `SelfVoteNotAllowed` (#2216) fire on the cast path
		// only, so `retractDefinitionVote` keeps its `DefinitionNotFound` channel.
		readonly voteDefinition: (
			input: VoteDefinitionInput,
		) => Effect.Effect<
			VoteDefinitionResult,
			DefinitionNotFound | VoterNotEligible | SelfVoteNotAllowed
		>;

		readonly retractDefinitionVote: (
			input: VoteDefinitionInput,
		) => Effect.Effect<VoteDefinitionResult, DefinitionNotFound>;

		/**
		 * Set / change / retract the reactor's single reaction on a definition (#1865).
		 * UNGATED and karma-free, unlike `voteDefinition` — a çaylak may react (#1861).
		 */
		readonly reactToDefinition: (
			input: ReactDefinitionInput,
		) => Effect.Effect<DefinitionRow, DefinitionNotFound>;

		/**
		 * Backstop reconciliation (#2558), driven by a cron trigger: re-converge every term's
		 * cached summary + stats, so anything left stale by a swallowed refresh (#2012) is
		 * fixed without waiting for a next user write. Idempotent.
		 */
		readonly reconcileCaches: (now: Date) => Effect.Effect<{readonly scanned: number}>;
	}
>()("@kampus/sozluk/Sozluk") {}

export const SozlukLive = Layer.effect(Sozluk)(
	Effect.gen(function* () {
		// `orDieAccess`: DB failures are defects, so public signatures carry domain errors only.
		const {run, batch} = orDieAccess(yield* Drizzle);
		const voteSvc = yield* Vote;
		const reactionSvc = yield* Reaction;
		// Live author identity (#2139): reads render the CURRENT profile, never the
		// write-time `authorName` snapshot.
		const pasaport = yield* Pasaport;

		const removalSeq: Removal.RemovalSequence = {run, batch, clearTarget: voteSvc.clearTarget};

		const definitionVoteScalar = {
			field: "myVote",
			read: (viewerId: string | null | undefined, ids: ReadonlyArray<string>) =>
				voteSvc.readMine(viewerId, "definition", ids),
		} as const;

		const stampDefinitions = <R extends {id: string; authorId: string}>(
			rows: ReadonlyArray<R>,
			viewerId: string | null,
			parallelStamps: boolean,
		) => {
			const concurrency = parallelStamps ? "unbounded" : 1;
			return parallelStampWave(
				rows,
				[
					(rs) => stampViewerScalars(rs, viewerId, [definitionVoteScalar]),
					(rs) => stampReactionAggregate(reactionSvc, "definition", rs, viewerId, {concurrency}),
					(rs) => stampAuthorIdentity(pasaport.getProfileIdentitiesByIds, rs),
				],
				{concurrency},
			);
		};

		const persistTermSummary = Effect.fn("Sozluk.recomputeTermSummary")(function* (
			slug: string,
			title: string,
			now: Date,
		) {
			const defs = yield* run((db) =>
				db
					.select({
						id: schema.definitionRecord.id,
						body: schema.definitionRecord.body,
						bodyExcerpt: schema.definitionRecord.bodyExcerpt,
						score: schema.definitionRecord.score,
						createdAt: schema.definitionRecord.createdAt,
						updatedAt: schema.definitionRecord.updatedAt,
					})
					.from(schema.definitionRecord)
					.where(
						and(
							eq(schema.definitionRecord.termSlug, slug),
							isNull(schema.definitionRecord.removedAt),
							// The public term card reflects LIVE content only — a sandboxed
							// definition (#1205) is pending, never in the public aggregate.
							isNull(schema.definitionRecord.sandboxedAt),
						),
					)
					.orderBy(desc(schema.definitionRecord.score), asc(schema.definitionRecord.createdAt)),
			);

			const summary = recomputeTermSummary(defs, slug, title, now);

			// Summary upsert + its FTS dual-write in ONE batch so they move all-or-none
			// (ADR 0080). Both items must be drizzle query builders, NOT `db.run(sql)`: a
			// batch item must `_prepare()` to a `D1PreparedQuery` with a bound `.stmt`, which
			// a parametrized `SQLiteRaw` lacks — it 500s the whole batch on real D1 (#863).
			yield* batch((db) => [
				db
					.insert(schema.termRecord)
					.values({
						slug: summary.slug,
						title: summary.title,
						firstLetter: summary.firstLetter,
						definitionCount: summary.definitionCount,
						totalScore: summary.totalScore,
						excerpt: summary.excerpt,
						topDefinitionId: summary.topDefinitionId,
						firstAt: summary.firstAt,
						lastActivityAt: now,
						lastEditAt: summary.lastEditAt,
					})
					.onConflictDoUpdate({
						target: schema.termRecord.slug,
						set: {
							title: sql`excluded.title`,
							definitionCount: sql`excluded.definition_count`,
							totalScore: sql`excluded.total_score`,
							excerpt: sql`excluded.excerpt`,
							topDefinitionId: sql`excluded.top_definition_id`,
							firstAt: sql`excluded.first_at`,
							lastActivityAt: sql`excluded.last_activity_at`,
							lastEditAt: sql`excluded.last_edit_at`,
						},
					}),
				...syncTermSearch(db, slug, title),
			]);
		});

		// The write is owned by the mutation path, not the query-only stats feature (ADR 0117).
		const recomputeSozlukStats = Effect.fn("Sozluk.recomputeSozlukStats")(function* (now: Date) {
			const totalTermsRow = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.termRecord)
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			// Public counts are LIVE-only, from the shared seam (#1359/#1407) rather than
			// re-derived here.
			const publicDefWhere = publicLiveWhere(
				{
					removedAt: schema.definitionRecord.removedAt,
					sandboxedAt: schema.definitionRecord.sandboxedAt,
					authorId: schema.definitionRecord.authorId,
				},
				anonymousViewer,
			);
			const totalDefsRow = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.definitionRecord)
					.where(publicDefWhere)
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			const totalAuthorsRow = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(DISTINCT ${schema.definitionRecord.authorId})`})
					.from(schema.definitionRecord)
					.where(publicDefWhere)
					.then((r) => Number(r[0]?.n ?? 0)),
			);

			const nowSec = Math.floor(now.getTime() / 1000);
			yield* run((db) =>
				db.run(sql`
					INSERT INTO sozluk_stats (id, total_definitions, total_terms, total_authors, updated_at)
					VALUES (1, ${totalDefsRow}, ${totalTermsRow}, ${totalAuthorsRow}, ${nowSec})
					ON CONFLICT(id) DO UPDATE SET
						total_definitions = excluded.total_definitions,
						total_terms       = excluded.total_terms,
						total_authors     = excluded.total_authors,
						updated_at        = excluded.updated_at
				`),
			);
		});

		// The recomputable-cache refresh (ADR 0011) the shared removal transition swallows.
		const refreshSozlukCaches = (slug: string, title: string, now: Date) =>
			Effect.gen(function* () {
				yield* persistTermSummary(slug, title, now);
				yield* recomputeSozlukStats(now);
			});

		const reconcileCaches = Effect.fn("Sozluk.reconcileCaches")(function* (now: Date) {
			const ports: SozlukReconcileScanPorts = {
				fetchChunk: (afterSlug, limit) =>
					run((db) =>
						db
							.select({slug: schema.termRecord.slug, title: schema.termRecord.title})
							.from(schema.termRecord)
							.where(afterSlug === null ? undefined : gt(schema.termRecord.slug, afterSlug))
							.orderBy(asc(schema.termRecord.slug))
							.limit(limit),
					),
				refreshTerm: (term) => persistTermSummary(term.slug, term.title, now),
			};
			const {scanned} = yield* scanReconcileChunks(ports, SOZLUK_RECONCILE_CHUNK);
			// `sozluk_stats` totals are table-wide, so one refresh per pass suffices.
			yield* recomputeSozlukStats(now);
			return {scanned};
		});

		const getTerm = Effect.fn("Sozluk.getTerm")(function* (
			slug: string,
			opts: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined} = {},
		) {
			const meta = yield* run((db) => db.query.termRecord.findFirst({where: {slug}}));
			if (!meta) return null;

			const viewer = resolveSandboxViewer(opts);
			const defs = yield* run((db) =>
				db
					.select()
					.from(schema.definitionRecord)
					.where(
						and(
							eq(schema.definitionRecord.termSlug, slug),
							isNull(schema.definitionRecord.removedAt),
							sandboxVisibleWhere(
								{
									sandboxedAt: schema.definitionRecord.sandboxedAt,
									authorId: schema.definitionRecord.authorId,
								},
								viewer,
							),
						),
					)
					.orderBy(desc(schema.definitionRecord.score), asc(schema.definitionRecord.createdAt)),
			);

			const firstAt = earliestCreatedAt(defs) ?? meta.firstAt ?? new Date(0);
			const lastEdit = latestEditAt(defs) ?? meta.lastEditAt ?? firstAt;

			return {
				id: meta.slug,
				slug: meta.slug,
				title: meta.title,
				totalDefinitions: defs.length,
				totalScore: defs.reduce((s, d) => s + d.score, 0),
				firstAt,
				lastEdit,
				definitions: defs.map(toDefinitionRow),
			} satisfies TermPage;
		});

		const listDefinitionsKeyset = Effect.fn("Sozluk.listDefinitionsKeyset")(function* (
			slug: string,
			opts: {
				first?: number | undefined;
				after?: string | null | undefined;
				viewerId?: string | null | undefined;
				sandboxViewer?: SandboxViewer | undefined;
				mutedIds?: ReadonlySet<string> | undefined;
				parallelStamps?: boolean | undefined;
			} = {},
		) {
			const first = Math.max(1, Math.min(opts.first ?? 50, 200));
			const after = opts.after ?? null;
			const viewerId = opts.viewerId ?? null;
			const viewer = resolveSandboxViewer(opts);

			const baseWhere = and(
				eq(schema.definitionRecord.termSlug, slug),
				isNull(schema.definitionRecord.removedAt),
				sandboxVisibleWhere(
					{
						sandboxedAt: schema.definitionRecord.sandboxedAt,
						authorId: schema.definitionRecord.authorId,
					},
					viewer,
				),
				// Mute read-mask (#3113): hide muted authors' definitions from the muter.
				mutedAuthorsWhere(schema.definitionRecord.authorId, opts.mutedIds),
			);
			const totalCount = yield* run((db) =>
				db
					.select({n: sql<number>`count(*)`})
					.from(schema.definitionRecord)
					.where(baseWhere)
					.get()
					.then((r) => r?.n ?? 0),
			);

			// `resolveCursor` is the pure cursor-miss decision (ADR 0082).
			const resolvedRow = after
				? ((yield* run((db) =>
						db
							.select({
								score: schema.definitionRecord.score,
								createdAt: schema.definitionRecord.createdAt,
							})
							.from(schema.definitionRecord)
							.where(eq(schema.definitionRecord.id, after))
							.get(),
					)) ?? null)
				: null;
			const cursor = resolveCursor(after, resolvedRow);
			if (cursor.kind === "miss") {
				return {...emptyKeysetPage, totalCount} satisfies DefinitionConnectionPage;
			}
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

			// The `id` cursor value is the opaque `after` itself — the resolved row carries
			// only `score`/`createdAt`.
			const cursorPredicate = keysetAfter(
				keysetKeys(DEFINITION_ORDERING, (field) =>
					field === "id" ? after : ((cursorRow as Record<string, unknown> | null)?.[field] ?? null),
				),
			);

			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.definitionRecord)
					.where(cursorPredicate ? and(baseWhere, cursorPredicate) : baseWhere)
					.orderBy(...orderByColumns(DEFINITION_ORDERING))
					.limit(first + 1),
			);

			// `sandboxed` is the owner-scoped in-review flag (#2200): computed off the fetched
			// record against the viewer, so a çaylak sees the "incelemede" signal on their OWN
			// still-in-review definition and no other viewer ever receives it.
			// `sandboxedInPlace` (#6425) is the other audience's marker off the SAME resolved
			// viewer — the opted-in in-place reader's honest "this is çaylak work" signal.
			const page = forwardPage(
				fetched,
				first,
				(r: DefinitionRow) => r.id,
				(d) => ({
					...toDefinitionRow(d),
					sandboxed: ownSandboxed(d, viewerId),
					sandboxedInPlace: sandboxedInPlace(d, viewer),
				}),
			);
			const rows = yield* stampDefinitions(page.rows, viewerId, opts.parallelStamps ?? false);

			return {...page, rows, totalCount} satisfies DefinitionConnectionPage;
		});

		const getDefinitionsByIds = Effect.fn("Sozluk.getDefinitionsByIds")(function* (
			ids: ReadonlyArray<string>,
			opts: {
				viewerId?: string | null | undefined;
				sandboxViewer?: SandboxViewer | undefined;
				mutedIds?: ReadonlySet<string> | undefined;
				parallelStamps?: boolean | undefined;
			} = {},
		) {
			if (ids.length === 0) return [];
			const viewerId = opts.viewerId ?? null;
			const viewer = resolveSandboxViewer(opts);
			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.definitionRecord)
					.where(
						and(
							inArray(schema.definitionRecord.id, [...ids]),
							isNull(schema.definitionRecord.removedAt),
							sandboxVisibleWhere(
								{
									sandboxedAt: schema.definitionRecord.sandboxedAt,
									authorId: schema.definitionRecord.authorId,
								},
								viewer,
							),
							// Mute read-mask (#3113): drop muted authors' definitions from the batch.
							mutedAuthorsWhere(schema.definitionRecord.authorId, opts.mutedIds),
						),
					),
			);
			const base = fetched.map((d) => ({
				...toDefinitionRow(d),
				sandboxed: ownSandboxed(d, viewerId),
				sandboxedInPlace: sandboxedInPlace(d, viewer),
			}));
			return yield* stampDefinitions(base, viewerId, opts.parallelStamps ?? false);
		});

		const listSandboxedDefinitions = Effect.fn("Sozluk.listSandboxedDefinitions")(function* (
			opts: {authorId?: string | undefined} = {},
		) {
			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.definitionRecord)
					.where(
						sandboxBacklogWhere(
							{
								sandboxedAt: schema.definitionRecord.sandboxedAt,
								removedAt: schema.definitionRecord.removedAt,
								authorId: schema.definitionRecord.authorId,
							},
							{authorId: opts.authorId},
						),
					)
					.orderBy(desc(schema.definitionRecord.createdAt)),
			);
			return fetched.map(toDefinitionRow);
		});

		const getTermSummariesByIds = Effect.fn("Sozluk.getTermSummariesByIds")(function* (
			slugs: ReadonlyArray<string>,
		) {
			if (slugs.length === 0) return [];
			const rows = yield* run((db) =>
				db
					.select(termSummaryColumns)
					.from(schema.termRecord)
					.where(inArray(schema.termRecord.slug, [...slugs])),
			);
			return rows.map(toTermSummaryRow);
		});

		const listTermSummaries = Effect.fn("Sozluk.listTermSummaries")(function* (
			opts: {sort?: ListSort; limit?: number} = {},
		) {
			const sort = opts.sort ?? "recent";
			const limit = opts.limit ?? 50;

			const rows = yield* run((db) =>
				db
					.select(termSummaryColumns)
					.from(schema.termRecord)
					.orderBy(
						sort === "popular"
							? desc(schema.termRecord.totalScore)
							: desc(schema.termRecord.lastActivityAt),
					)
					.limit(limit),
			);

			return rows.map(toTermSummaryRow);
		});

		const listTermSummariesConnection = Effect.fn("Sozluk.listTermSummariesConnection")(function* (
			opts: {
				sort?: ListSort;
				first?: number;
				after?: string | null;
				viewerId?: string | null | undefined;
				sandboxViewer?: SandboxViewer | undefined;
			} = {},
		) {
			const sort = opts.sort ?? "recent";
			const first = Math.max(1, Math.min(opts.first ?? 20, 100));
			const after = opts.after ?? null;
			const viewer = resolveSandboxViewer(opts);

			// The count carries the SAME mask as the page below: an unmasked `count(*)`
			// would report terms the page can never yield, so the connection would claim
			// pages that don't exist.
			const totalCount = yield* run((db) =>
				db
					.select({n: sql<number>`count(*)`})
					.from(schema.termRecord)
					.where(termHasVisibleDefinitionWhere(db, viewer))
					.get()
					.then((r) => r?.n ?? 0),
			);

			type CursorRow = {slug: string; totalScore: number; lastActivityAt: Date | null};
			// Deliberately UNMASKED: this read only recovers the cursor's keyset position,
			// it never yields a row. Masking it would turn a cursor whose term went
			// sandboxed mid-scroll into a cursor miss and truncate the rest of the list.
			const resolvedRow = after
				? ((yield* run((db) =>
						db
							.select({
								slug: schema.termRecord.slug,
								totalScore: schema.termRecord.totalScore,
								lastActivityAt: schema.termRecord.lastActivityAt,
							})
							.from(schema.termRecord)
							.where(eq(schema.termRecord.slug, after))
							.get(),
					)) ?? null)
				: null;
			const cursor = resolveCursor<CursorRow>(after, resolvedRow);
			if (cursor.kind === "miss") {
				return {...emptyKeysetPage, totalCount} satisfies TermConnectionPage;
			}
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

			// A null `lastActivityAt` cursor value drops the lead column → slug-only keyset.
			const ordering = TERM_SUMMARY_ORDERING[sort];
			const cursorPredicate = keysetAfter(
				keysetKeys(
					ordering,
					(field) => (cursorRow as Record<string, unknown> | null)?.[field] ?? null,
				),
			);

			const fetched = yield* run((db) =>
				db
					.select(termSummaryColumns)
					.from(schema.termRecord)
					.where(and(cursorPredicate, termHasVisibleDefinitionWhere(db, viewer)))
					.orderBy(...orderByColumns(ordering))
					.limit(first + 1),
			);

			const page = forwardPage(fetched, first, (r) => r.slug, toTermSummaryRow);

			return {...page, totalCount} satisfies TermConnectionPage;
		});

		const getLandingTerms = Effect.fn("Sozluk.getLandingTerms")(function* (limit: number) {
			const n = Math.max(1, Math.min(limit, 50));
			// The mask lives on the `definition_record` arm, mirroring `landingStats` (#1391):
			// a term with only sandboxed definitions contributes no row, so its `term_record`
			// summary never reaches the public front door (#1205, #1424).
			const slugRows = yield* run((db) =>
				db
					.select({
						termSlug: schema.definitionRecord.termSlug,
						lastCreated: sql<number>`max(${schema.definitionRecord.createdAt})`,
					})
					.from(schema.definitionRecord)
					.where(
						and(
							isNull(schema.definitionRecord.removedAt),
							isNull(schema.definitionRecord.sandboxedAt),
						),
					)
					.groupBy(schema.definitionRecord.termSlug)
					.orderBy(desc(sql`max(${schema.definitionRecord.createdAt})`))
					.limit(n),
			);
			const slugs = slugRows.map((r) => r.termSlug);
			if (slugs.length === 0) return [];

			const summaries = yield* run((db) =>
				db
					.select(termSummaryColumns)
					.from(schema.termRecord)
					.where(inArray(schema.termRecord.slug, slugs)),
			);
			const bySlug = new Map(summaries.map((r) => [r.slug, toTermSummaryRow(r)]));
			// Re-order to the recency keyset (`inArray` loses the order).
			return slugs.flatMap((slug) => {
				const row = bySlug.get(slug);
				return row ? [row] : [];
			});
		});

		const lookupDefinitionTermSlug = Effect.fn("Sozluk.lookupDefinitionTermSlug")(function* (
			definitionId: string,
		) {
			const rows = yield* run((db) =>
				db
					.select({termSlug: schema.definitionRecord.termSlug})
					.from(schema.definitionRecord)
					.where(eq(schema.definitionRecord.id, definitionId))
					.limit(1),
			);
			return rows[0]?.termSlug ?? null;
		});

		const addDefinition = Effect.fn("Sozluk.addDefinition")(function* (input: AddDefinitionInput) {
			const rawBody = yield* validateBody(input.body);

			const slug = input.termSlug;
			const existing = yield* run((db) => db.query.termRecord.findFirst({where: {slug}}));
			const termCreated = !existing;
			const title = existing?.title ?? input.termTitle ?? titleFromSlug(slug);

			const definitionId = id("def");
			const now = new Date();
			const bodyExcerpt = excerpt(rawBody);

			yield* run((db) =>
				db.insert(schema.definitionRecord).values({
					id: definitionId,
					authorId: input.authorId,
					authorName: input.authorName,
					termSlug: slug,
					termTitle: title,
					body: rawBody,
					bodyExcerpt,
					score: 0,
					createdAt: now,
					updatedAt: now,
					removedAt: null,
					removedBy: null,
					removedReason: null,
					sandboxedAt: input.sandboxedAt ?? null,
				}),
			);

			// The row is already committed, so swallow a refresh die rather than 500 the
			// mutation and provoke a retry that mints a duplicate row (#2556).
			yield* swallowRefresh(
				"Sozluk.addDefinition",
				Effect.gen(function* () {
					yield* persistTermSummary(slug, title, now);
					yield* recomputeSozlukStats(now);
				}),
			);

			return {
				definitionId,
				termCreated,
				score: 0,
				body: rawBody,
				authorId: input.authorId,
				authorName: input.authorName,
				createdAt: now,
				updatedAt: now,
			} satisfies AddDefinitionResult;
		});

		const editDefinition = Effect.fn("Sozluk.editDefinition")(function* (
			input: EditDefinitionInput,
		) {
			const rawBody = yield* validateBody(input.body);

			const definition = yield* run((db) =>
				db.query.definitionRecord.findFirst({
					where: {id: input.definitionId, removedAt: {isNull: true}},
				}),
			);
			if (!definition) {
				return yield* new DefinitionNotFound({
					definitionId: input.definitionId,
					message: `definition ${input.definitionId} not found`,
				});
			}
			if (definition.authorId !== input.actorId) {
				return yield* new UnauthorizedDefinitionMutation({
					definitionId: input.definitionId,
					message: `not authorized to mutate definition ${input.definitionId}`,
				});
			}

			const now = new Date();
			const bodyExcerpt = excerpt(rawBody);

			yield* run((db) =>
				db
					.update(schema.definitionRecord)
					.set({body: rawBody, bodyExcerpt, updatedAt: now})
					.where(eq(schema.definitionRecord.id, input.definitionId)),
			);

			yield* persistTermSummary(definition.termSlug, definition.termTitle, now);

			return {
				definitionId: input.definitionId,
				score: definition.score,
				body: rawBody,
				authorId: definition.authorId,
				authorName: definition.authorName,
				createdAt: definition.createdAt ?? now,
				updatedAt: now,
			} satisfies EditDefinitionResult;
		});

		// Remove → restore both flow through the ADR 0096 substrate; votes are wiped and
		// karma KEPT. Caches refresh outside the cleanup batch (ADR 0011).
		const deleteDefinition = Effect.fn("Sozluk.deleteDefinition")(function* (
			input: DeleteDefinitionInput,
		) {
			const definition = yield* run((db) =>
				db.query.definitionRecord.findFirst({
					where: {id: input.definitionId},
				}),
			);
			if (!definition) {
				return yield* new DefinitionNotFound({
					definitionId: input.definitionId,
					message: `definition ${input.definitionId} not found`,
				});
			}
			if (definition.authorId !== input.actorId) {
				return yield* new UnauthorizedDefinitionMutation({
					definitionId: input.definitionId,
					message: `not authorized to mutate definition ${input.definitionId}`,
				});
			}

			const now = new Date();
			const outcome = yield* applyRemovalTransition({
				label: "Sozluk.deleteDefinition",
				transition: "remove",
				seq: removalSeq,
				subject: definition,
				target: {kind: "definition", id: input.definitionId},
				removedBy: input.actorId,
				reason: input.reason ?? new Removal.AuthorDeletion(),
				now,
				refresh: refreshSozlukCaches(definition.termSlug, definition.termTitle, now),
			});

			return {
				definitionId: input.definitionId,
				deleted: outcome.committed,
			} satisfies DeleteDefinitionResult;
		});

		const restoreDefinition = Effect.fn("Sozluk.restoreDefinition")(function* (
			input: DeleteDefinitionInput,
		) {
			const definition = yield* run((db) =>
				db.query.definitionRecord.findFirst({where: {id: input.definitionId}}),
			);
			if (!definition) {
				return yield* new DefinitionNotFound({
					definitionId: input.definitionId,
					message: `definition ${input.definitionId} not found`,
				});
			}
			if (definition.authorId !== input.actorId) {
				return yield* new UnauthorizedDefinitionMutation({
					definitionId: input.definitionId,
					message: `not authorized to mutate definition ${input.definitionId}`,
				});
			}

			const now = new Date();
			const outcome = yield* applyRemovalTransition({
				label: "Sozluk.restoreDefinition",
				transition: "restore",
				seq: removalSeq,
				subject: definition,
				target: {kind: "definition", id: input.definitionId},
				now,
				refresh: refreshSozlukCaches(definition.termSlug, definition.termTitle, now),
			});
			if (!outcome.committed) {
				return {definitionId: input.definitionId, deleted: false} satisfies DeleteDefinitionResult;
			}

			return {
				definitionId: input.definitionId,
				deleted: true,
				sandboxedAt: outcome.sandboxedAt,
			} satisfies DeleteDefinitionResult;
		});

		const moderateRemoveDefinition = Effect.fn("Sozluk.moderateRemoveDefinition")(
			function* (input: {definitionId: string; resolverId: string; reportId: ReportId}) {
				const definition = yield* run((db) =>
					db.query.definitionRecord.findFirst({where: {id: input.definitionId}}),
				);
				if (!definition) return {removed: false};

				const now = new Date();
				const outcome = yield* applyRemovalTransition({
					label: "Sozluk.moderateRemoveDefinition",
					transition: "remove",
					seq: removalSeq,
					subject: definition,
					target: {kind: "definition", id: input.definitionId},
					removedBy: input.resolverId,
					reason: new Removal.Moderated({reportId: input.reportId}),
					now,
					refresh: refreshSozlukCaches(definition.termSlug, definition.termTitle, now),
				});

				return {removed: outcome.committed};
			},
		);

		const moderateRestoreDefinition = Effect.fn("Sozluk.moderateRestoreDefinition")(
			function* (input: {definitionId: string}) {
				const definition = yield* run((db) =>
					db.query.definitionRecord.findFirst({where: {id: input.definitionId}}),
				);
				if (!definition) return {restored: false, sandboxedAt: null};

				const now = new Date();
				const outcome = yield* applyRemovalTransition({
					label: "Sozluk.moderateRestoreDefinition",
					transition: "restore",
					seq: removalSeq,
					subject: definition,
					target: {kind: "definition", id: input.definitionId},
					now,
					refresh: refreshSozlukCaches(definition.termSlug, definition.termTitle, now),
				});
				if (!outcome.committed) return {restored: false, sandboxedAt: null};

				// The round-tripped marker (#1811): a sandboxed restore stays suppressed on
				// the term-connection broadcast.
				return {restored: true, sandboxedAt: outcome.sandboxedAt};
			},
		);

		const applyVote = Effect.fn("Sozluk.applyVote")(function* (
			input: VoteDefinitionInput,
			isVote: boolean,
		) {
			const definition = yield* run((db) =>
				db.query.definitionRecord.findFirst({
					where: {id: input.definitionId, removedAt: {isNull: true}},
				}),
			);
			if (!definition) {
				return yield* new DefinitionNotFound({
					definitionId: input.definitionId,
					message: `definition ${input.definitionId} not found`,
				});
			}

			// Self-vote guard (#2216, founder-ruled). Cast-only: a retraction is exempt
			// because a blocked cast leaves nothing to retract.
			if (isVote && definition.authorId === input.voterId) {
				return yield* new SelfVoteNotAllowed({
					voterId: input.voterId,
					message: "kendi tanımına oy veremezsin",
				});
			}

			// A Vote miss (raced soft-delete or sandboxed) collapses to `DefinitionNotFound`.
			const voteResult = yield* voteSvc
				.cast({
					userId: input.voterId,
					targetKind: "definition",
					targetId: input.definitionId,
					value: isVote,
				})
				.pipe(
					translateVoteMiss(
						() =>
							new DefinitionNotFound({
								definitionId: input.definitionId,
								message: `definition ${input.definitionId} not found`,
							}),
					),
				);

			const now = new Date();
			if (voteResult.changed) {
				yield* persistTermSummary(definition.termSlug, definition.termTitle, now);
			}

			return {
				definitionId: input.definitionId,
				score: voteResult.score,
				body: definition.body,
				authorId: definition.authorId,
				authorName: definition.authorName,
				createdAt: definition.createdAt ?? now,
				// A vote is not a content edit: the vote instant here would trip the
				// "düzenlendi" badge on the live-push (#1634).
				updatedAt: definition.updatedAt ?? definition.createdAt ?? now,
				myVote: voteResult.myVote,
				changed: voteResult.changed,
			} satisfies VoteDefinitionResult;
		});

		const voteDefinition = Effect.fn("Sozluk.voteDefinition")(function* (
			input: VoteDefinitionInput,
		) {
			return yield* applyVote(input, true);
		});

		const retractDefinitionVote = Effect.fn("Sozluk.retractDefinitionVote")(function* (
			input: VoteDefinitionInput,
		) {
			// Both fire on the cast direction only, so a retraction never raises either —
			// die if one somehow does, keeping this channel to `DefinitionNotFound`.
			return yield* applyVote(input, false).pipe(
				Effect.catchTags({
					"vote/VoterNotEligible": (e) => Effect.die(e),
					"vote/SelfVoteNotAllowed": (e) => Effect.die(e),
				}),
			);
		});

		const reactToDefinition = Effect.fn("Sozluk.reactToDefinition")(function* (
			input: ReactDefinitionInput,
		) {
			// No sandbox filter — reactions are ungated, so a live target is reactable
			// regardless of the reactor's tier.
			const definition = yield* run((db) =>
				db.query.definitionRecord.findFirst({
					where: {id: input.definitionId, removedAt: {isNull: true}},
				}),
			);
			if (!definition) {
				return yield* new DefinitionNotFound({
					definitionId: input.definitionId,
					message: `definition ${input.definitionId} not found`,
				});
			}

			// No tier gate and no karma write on this path (the settled #1861 divergence
			// from Vote).
			yield* reactionSvc
				.react({
					userId: input.reactorId,
					targetKind: "definition",
					targetId: input.definitionId,
					emoji: input.emoji,
				})
				.pipe(
					Effect.catchTag("reaction/ReactionTargetNotFound", () =>
						Effect.fail(
							new DefinitionNotFound({
								definitionId: input.definitionId,
								message: `definition ${input.definitionId} not found`,
							}),
						),
					),
				);

			// Re-resolve through the same stamps every definition read shares, so the wire
			// row is shape-identical to a plain read.
			const scalared = yield* stampViewerScalars([toDefinitionRow(definition)], input.reactorId, [
				definitionVoteScalar,
			]);
			const reacted = yield* stampReactionAggregate(
				reactionSvc,
				"definition",
				scalared,
				input.reactorId,
			);
			const [row] = yield* stampAuthorIdentity(pasaport.getProfileIdentitiesByIds, reacted);
			return row as DefinitionRow;
		});

		return {
			getTerm,
			listDefinitionsKeyset,
			getDefinitionsByIds,
			listSandboxedDefinitions,
			getTermSummariesByIds,
			listTermSummaries,
			listTermSummariesConnection,
			getLandingTerms,
			lookupDefinitionTermSlug,
			addDefinition,
			editDefinition,
			deleteDefinition,
			restoreDefinition,
			moderateRemoveDefinition,
			moderateRestoreDefinition,
			voteDefinition,
			retractDefinitionVote,
			reactToDefinition,
			reconcileCaches,
		};
	}),
);
