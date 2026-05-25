/**
 * Sozluk — the dictionary feature service.
 *
 * Resolver-facing surface for term reads + definition CRUD + connection-shaped
 * pagination. Every method in this file replaces an async export from the
 * legacy `worker/features/sozluk/module.ts` + `termSummaryReader.ts` +
 * `userVoteReader.ts` files. Wire codes and result shapes are preserved
 * identically; the only thing that changes is the call form (Effect over
 * Promise).
 *
 * Vote mutations delegate to `Vote.cast` rather than reimplementing the
 * batch-vote/karma logic — `voteDefinition` / `retractDefinitionVote` are
 * thin wrappers that recompute `term_summary` aggregates after the shared
 * vote service does its atomic write.
 *
 * Validation lives inside the service methods as closure helpers (ADR 0013).
 * `recomputeTermSummary` and `recomputeSozlukStats` are also closure-private
 * — they're load-bearing helpers but not part of the public surface.
 */
import {id} from "@usirin/forge";
import {and, asc, desc, eq, inArray, isNull, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import * as schema from "../../db/drizzle/schema";
import {forwardPage, keysetAfter} from "../../db/keyset";
import {Drizzle, type DrizzleError} from "../../services/Drizzle";
import {excerpt as excerptText} from "../../shared/text";
import type {VoteTargetNotFound} from "../vote/errors";
import {Vote} from "../vote/Vote";
import {
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
} from "./errors";

/* -------------------------------------------------------------------------- */
/* Domain constants                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Body length cap for definitions — surfaced as `BODY_TOO_LONG` on overflow.
 * Mirrors the pre-effect-migration `DEFINITION_BODY_MAX`.
 */
export const DEFINITION_BODY_MAX = 10_000;

/** Excerpt cap for `definition_view.body_excerpt` and `term_summary.excerpt`. */
const DEFINITION_EXCERPT_LEN = 140;

const excerpt = (body: string): string => excerptText(body, DEFINITION_EXCERPT_LEN);

/* -------------------------------------------------------------------------- */
/* Read shapes                                                                 */
/* -------------------------------------------------------------------------- */

export interface DefinitionRow {
	id: string;
	score: number;
	body: string;
	author: string;
	/** Pasaport user id of the author — gates edit / delete affordances. */
	authorId: string;
	createdAt: Date;
	updatedAt: Date;
	/**
	 * `1` if the viewer has upvoted this definition, `null` otherwise. Populated
	 * by the fate batch reads (`getDefinitionsByIds`, `listDefinitionsKeyset`)
	 * when a `viewerId` is supplied — so a definition list resolves the
	 * `Definition.myVote` view field for the whole batch in one `user_vote` query
	 * instead of a per-row N+1. `undefined` when not requested (anonymous viewer
	 * / read paths that omit it).
	 */
	myVote?: number | null;
}

export interface TermPage {
	id: string;
	slug: string;
	title: string;
	totalDefinitions: number;
	totalScore: number;
	firstAt: Date;
	lastEdit: Date;
	definitions: DefinitionRow[];
}

export interface DefinitionConnectionPage {
	rows: DefinitionRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

export type ListSort = "recent" | "popular";

export interface TermSummaryRow {
	id: string;
	slug: string;
	title: string;
	count: number;
	totalScore: number;
	excerpt: string | null;
	firstAt: Date | null;
	lastEdit: Date | null;
	firstLetter: string;
	definitionCount: number;
	lastActivityAt: Date | null;
}

export interface TermConnectionPage {
	rows: TermSummaryRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

/* -------------------------------------------------------------------------- */
/* Mutation shapes                                                             */
/* -------------------------------------------------------------------------- */

export interface AddDefinitionInput {
	termSlug: string;
	authorId: string;
	authorName: string;
	body: string;
	/** Optional human title. Falls back to slug-with-spaces. */
	termTitle?: string | undefined;
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

export interface VoteDefinitionInput {
	definitionId: string;
	voterId: string;
}

export interface VoteDefinitionResult {
	definitionId: string;
	score: number;
	body: string;
	authorId: string;
	authorName: string;
	createdAt: Date;
	updatedAt: Date;
	/** `1` if the voter has voted on this definition (post-write), `null` otherwise. */
	myVote: number | null;
	/** `true` if the vote-row state changed; `false` on idempotent no-op. */
	changed: boolean;
}

export interface EditDefinitionInput {
	definitionId: string;
	actorId: string;
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
	definitionId: string;
	actorId: string;
}

export interface DeleteDefinitionResult {
	definitionId: string;
	/** `true` if the row was soft-deleted; `false` on idempotent no-op. */
	deleted: boolean;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

export class Sozluk extends Context.Service<
	Sozluk,
	{
		readonly getTerm: (slug: string) => Effect.Effect<TermPage | null, DrizzleError>;

		/**
		 * DB-keyset page of a term's live definitions, ordered by the canonical
		 * `(score desc, created_at asc, id asc)` term-page order, for the
		 * fate `Term.definitions` connection: the cursor is a definition id, and
		 * the keyset predicate fetches the rows that follow it in that order, so a
		 * page is a bounded `WHERE … LIMIT` rather than loading every definition.
		 *
		 * `viewerId` batches `myVote` for the whole page in one `user_vote` read.
		 */
		readonly listDefinitionsKeyset: (
			slug: string,
			opts?: {
				first?: number | undefined;
				after?: string | null | undefined;
				viewerId?: string | null | undefined;
			},
		) => Effect.Effect<DefinitionConnectionPage, DrizzleError>;

		/**
		 * Batched read of definitions by id (the fate `Definition` source's
		 * `byIds` workhorse — avoids the relation N+1). `viewerId` stamps `myVote`
		 * for the whole batch in one `user_vote` query. Soft-deleted rows are
		 * skipped; order is not guaranteed (fate re-associates by id).
		 */
		readonly getDefinitionsByIds: (
			ids: ReadonlyArray<string>,
			opts?: {viewerId?: string | null | undefined},
		) => Effect.Effect<DefinitionRow[], DrizzleError>;

		/**
		 * Batched read of term summaries by slug (the fate `Term` source's `byIds`
		 * workhorse). Order is not guaranteed (fate re-associates by id).
		 */
		readonly getTermSummariesByIds: (
			slugs: ReadonlyArray<string>,
		) => Effect.Effect<TermSummaryRow[], DrizzleError>;

		readonly listTermSummaries: (opts?: {
			sort?: ListSort;
			limit?: number;
		}) => Effect.Effect<TermSummaryRow[], DrizzleError>;

		readonly listTermSummariesConnection: (opts?: {
			sort?: ListSort;
			first?: number;
			after?: string | null;
		}) => Effect.Effect<TermConnectionPage, DrizzleError>;

		readonly readMyVote: (input: {
			userId: string;
			targetKind: "definition" | "post" | "comment";
			targetId: string;
		}) => Effect.Effect<number | null, DrizzleError>;

		readonly lookupDefinitionTermSlug: (
			definitionId: string,
		) => Effect.Effect<string | null, DrizzleError>;

		readonly addDefinition: (
			input: AddDefinitionInput,
		) => Effect.Effect<AddDefinitionResult, BodyRequired | BodyTooLong | DrizzleError>;

		readonly editDefinition: (
			input: EditDefinitionInput,
		) => Effect.Effect<
			EditDefinitionResult,
			| BodyRequired
			| BodyTooLong
			| DefinitionNotFound
			| UnauthorizedDefinitionMutation
			| DrizzleError
		>;

		readonly deleteDefinition: (
			input: DeleteDefinitionInput,
		) => Effect.Effect<
			DeleteDefinitionResult,
			DefinitionNotFound | UnauthorizedDefinitionMutation | DrizzleError
		>;

		readonly voteDefinition: (
			input: VoteDefinitionInput,
		) => Effect.Effect<VoteDefinitionResult, DefinitionNotFound | DrizzleError>;

		readonly retractDefinitionVote: (
			input: VoteDefinitionInput,
		) => Effect.Effect<VoteDefinitionResult, DefinitionNotFound | DrizzleError>;
	}
>()("@phoenix/sozluk/Sozluk") {}

/* -------------------------------------------------------------------------- */
/* Live layer                                                                  */
/* -------------------------------------------------------------------------- */

export const SozlukLive = Layer.effect(Sozluk)(
	Effect.gen(function* () {
		// Per the post-fbb57d8 reshape: yield Drizzle once at layer build and
		// destructure its bound methods. Method bodies call `run` directly so
		// every method's `R` stays `never` (or `Vote` for the vote-delegating
		// methods, since `voteSvc.cast` introduces `Vote` into `R`).
		const {run} = yield* Drizzle;
		const voteSvc = yield* Vote;

		/* ------------------------------------------------------------------ */
		/* Closure-private helpers                                             */
		/* ------------------------------------------------------------------ */

		/**
		 * Input validation for `body` fields on `addDefinition` /
		 * `editDefinition`. Returns the trimmed raw body when valid; fails
		 * with the appropriate tagged error otherwise. Per ADR 0013,
		 * validation lives in service methods, not resolvers.
		 */
		const validateBody = (body: string | null | undefined) =>
			Effect.gen(function* () {
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

		/**
		 * Recompute the `term_summary` row for one slug from the live
		 * `definition_view` slice (`WHERE term_slug = slug AND deleted_at IS NULL`).
		 * Convergent: the row is fully derived from definitions + meta (title).
		 */
		const recomputeTermSummary = Effect.fn("Sozluk.recomputeTermSummary")(function* (
			slug: string,
			title: string,
			now: Date,
		) {
			const defs = yield* run((db) =>
				db
					.select({
						id: schema.definitionView.id,
						body: schema.definitionView.body,
						bodyExcerpt: schema.definitionView.bodyExcerpt,
						score: schema.definitionView.score,
						createdAt: schema.definitionView.createdAt,
						updatedAt: schema.definitionView.updatedAt,
					})
					.from(schema.definitionView)
					.where(
						and(eq(schema.definitionView.termSlug, slug), isNull(schema.definitionView.deletedAt)),
					)
					.orderBy(desc(schema.definitionView.score), asc(schema.definitionView.createdAt)),
			);

			const totalScore = defs.reduce((s, d) => s + d.score, 0);
			const top = defs[0];
			const topExcerpt = top ? top.bodyExcerpt || excerpt(top.body) : null;
			const firstLetter = slug.charAt(0).toLowerCase();
			const firstAt =
				defs.reduce<Date | null>((acc, d) => {
					const c = d.createdAt;
					if (!c) return acc;
					return acc && acc < c ? acc : c;
				}, null) ?? now;
			const lastEditAt =
				defs.reduce<Date | null>((acc, d) => {
					const u = d.updatedAt ?? d.createdAt;
					if (!u) return acc;
					return acc && acc > u ? acc : u;
				}, null) ?? now;

			const firstAtSec = Math.floor(firstAt.getTime() / 1000);
			const lastActivitySec = Math.floor(now.getTime() / 1000);
			const lastEditSec = Math.floor(lastEditAt.getTime() / 1000);

			yield* run((db) =>
				db.run(sql`
					INSERT INTO term_summary (
						slug, title, first_letter, definition_count, total_score,
						excerpt, top_definition_id, first_at, last_activity_at,
						last_edit_at, last_event_id
					) VALUES (
						${slug}, ${title}, ${firstLetter}, ${defs.length}, ${totalScore},
						${topExcerpt}, ${top?.id ?? null}, ${firstAtSec}, ${lastActivitySec},
						${lastEditSec}, ''
					)
					ON CONFLICT(slug) DO UPDATE SET
						title             = excluded.title,
						definition_count  = excluded.definition_count,
						total_score       = excluded.total_score,
						excerpt           = excluded.excerpt,
						top_definition_id = excluded.top_definition_id,
						first_at          = excluded.first_at,
						last_activity_at  = excluded.last_activity_at,
						last_edit_at      = excluded.last_edit_at
				`),
			);
		});

		/**
		 * Refresh `sozluk_stats` totals. Three small COUNT queries plus one
		 * upsert. Cheap; runs after every write that could affect totals.
		 */
		const recomputeSozlukStats = Effect.fn("Sozluk.recomputeSozlukStats")(function* (now: Date) {
			const totalTermsRow = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.termSummary)
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			const totalDefsRow = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.definitionView)
					.where(isNull(schema.definitionView.deletedAt))
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			const totalAuthorsRow = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(DISTINCT ${schema.definitionView.authorId})`})
					.from(schema.definitionView)
					.where(isNull(schema.definitionView.deletedAt))
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

		/* ------------------------------------------------------------------ */
		/* Reads                                                               */
		/* ------------------------------------------------------------------ */

		const getTerm = Effect.fn("Sozluk.getTerm")(function* (slug: string) {
			const meta = yield* run((db) =>
				db.query.termSummary.findFirst({where: eq(schema.termSummary.slug, slug)}),
			);
			if (!meta) return null;

			const defs = yield* run((db) =>
				db
					.select()
					.from(schema.definitionView)
					.where(
						and(eq(schema.definitionView.termSlug, slug), isNull(schema.definitionView.deletedAt)),
					)
					.orderBy(desc(schema.definitionView.score), asc(schema.definitionView.createdAt)),
			);

			const firstAt =
				defs.reduce<Date | null>((acc, d) => {
					const c = d.createdAt;
					if (!c) return acc;
					return acc && acc < c ? acc : c;
				}, null) ??
				meta.firstAt ??
				new Date(0);
			const lastEdit =
				defs.reduce<Date | null>((acc, d) => {
					const u = d.updatedAt ?? d.createdAt;
					if (!u) return acc;
					return acc && acc > u ? acc : u;
				}, null) ??
				meta.lastEditAt ??
				firstAt;

			return {
				id: meta.slug,
				slug: meta.slug,
				title: meta.title,
				totalDefinitions: defs.length,
				totalScore: defs.reduce((s, d) => s + d.score, 0),
				firstAt,
				lastEdit,
				definitions: defs.map((d) => ({
					id: d.id,
					score: d.score,
					body: d.body,
					author: d.authorName,
					authorId: d.authorId,
					createdAt: d.createdAt ?? new Date(0),
					updatedAt: d.updatedAt ?? d.createdAt ?? new Date(0),
				})),
			} satisfies TermPage;
		});

		/**
		 * Batch `user_vote` presence for a viewer over a set of definition ids.
		 * One `WHERE user_id = ? AND target_kind = 'definition' AND target_id IN
		 * (...)` read; returns the set of voted ids so callers can stamp `myVote`
		 * without an N+1. Empty when there's no viewer or no ids.
		 */
		const readMyVotesBatch = Effect.fn("Sozluk.readMyVotesBatch")(function* (
			viewerId: string | null | undefined,
			definitionIds: ReadonlyArray<string>,
		) {
			if (!viewerId || definitionIds.length === 0) return new Set<string>();
			const rows = yield* run((db) =>
				db
					.select({targetId: schema.userVote.targetId})
					.from(schema.userVote)
					.where(
						and(
							eq(schema.userVote.userId, viewerId),
							eq(schema.userVote.targetKind, "definition"),
							inArray(schema.userVote.targetId, [...definitionIds]),
						),
					),
			);
			return new Set(rows.map((r) => r.targetId));
		});

		const mapDefinitionViewRow = (
			d: typeof schema.definitionView.$inferSelect,
			voted: Set<string>,
			viewerId: string | null | undefined,
		): DefinitionRow => ({
			id: d.id,
			score: d.score,
			body: d.body,
			author: d.authorName,
			authorId: d.authorId,
			createdAt: d.createdAt ?? new Date(0),
			updatedAt: d.updatedAt ?? d.createdAt ?? new Date(0),
			myVote: viewerId ? (voted.has(d.id) ? 1 : null) : null,
		});

		const listDefinitionsKeyset = Effect.fn("Sozluk.listDefinitionsKeyset")(function* (
			slug: string,
			opts: {
				first?: number | undefined;
				after?: string | null | undefined;
				viewerId?: string | null | undefined;
			} = {},
		) {
			const first = Math.max(1, Math.min(opts.first ?? 50, 200));
			const after = opts.after ?? null;
			const viewerId = opts.viewerId ?? null;

			const baseWhere = and(
				eq(schema.definitionView.termSlug, slug),
				isNull(schema.definitionView.deletedAt),
			);
			const totalCount = yield* run((db) =>
				db
					.select({n: sql<number>`count(*)`})
					.from(schema.definitionView)
					.where(baseWhere)
					.get()
					.then((r) => r?.n ?? 0),
			);

			// Resolve the cursor row's keyset tuple (score, createdAt, id) so the
			// predicate selects rows strictly after it in the canonical term-page
			// order: (score desc, created_at asc, id asc). An `after` that doesn't
			// resolve is a cursor miss → empty page (the shared semantic).
			let cursorRow: {score: number; createdAt: Date | null} | null = null;
			if (after) {
				cursorRow =
					(yield* run((db) =>
						db
							.select({
								score: schema.definitionView.score,
								createdAt: schema.definitionView.createdAt,
							})
							.from(schema.definitionView)
							.where(eq(schema.definitionView.id, after))
							.get(),
					)) ?? null;
				if (!cursorRow) {
					return {
						rows: [],
						hasNextPage: false,
						endCursor: null,
						totalCount,
					} satisfies DefinitionConnectionPage;
				}
			}

			// Mixed-direction keyset (score desc, created_at asc, id asc) declared
			// per column — `keysetAfter` builds the lexicographic predicate.
			const cursorPredicate = keysetAfter([
				{column: schema.definitionView.score, dir: "desc", value: cursorRow?.score ?? null},
				{column: schema.definitionView.createdAt, dir: "asc", value: cursorRow?.createdAt ?? null},
				{column: schema.definitionView.id, dir: "asc", value: after},
			]);

			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.definitionView)
					.where(cursorPredicate ? and(baseWhere, cursorPredicate) : baseWhere)
					.orderBy(
						desc(schema.definitionView.score),
						asc(schema.definitionView.createdAt),
						asc(schema.definitionView.id),
					)
					.limit(first + 1),
			);

			const voted = yield* readMyVotesBatch(
				viewerId,
				fetched.slice(0, first).map((d) => d.id),
			);
			const page = forwardPage(
				fetched,
				first,
				(r: DefinitionRow) => r.id,
				(d) => mapDefinitionViewRow(d, voted, viewerId),
			);

			return {...page, totalCount} satisfies DefinitionConnectionPage;
		});

		const getDefinitionsByIds = Effect.fn("Sozluk.getDefinitionsByIds")(function* (
			ids: ReadonlyArray<string>,
			opts: {viewerId?: string | null | undefined} = {},
		) {
			if (ids.length === 0) return [];
			const viewerId = opts.viewerId ?? null;
			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.definitionView)
					.where(
						and(
							inArray(schema.definitionView.id, [...ids]),
							isNull(schema.definitionView.deletedAt),
						),
					),
			);
			const voted = yield* readMyVotesBatch(
				viewerId,
				fetched.map((d) => d.id),
			);
			return fetched.map((d) => mapDefinitionViewRow(d, voted, viewerId));
		});

		const getTermSummariesByIds = Effect.fn("Sozluk.getTermSummariesByIds")(function* (
			slugs: ReadonlyArray<string>,
		) {
			if (slugs.length === 0) return [];
			const rows = yield* run((db) =>
				db
					.select({
						slug: schema.termSummary.slug,
						title: schema.termSummary.title,
						firstLetter: schema.termSummary.firstLetter,
						definitionCount: schema.termSummary.definitionCount,
						totalScore: schema.termSummary.totalScore,
						excerpt: schema.termSummary.excerpt,
						firstAt: schema.termSummary.firstAt,
						lastActivityAt: schema.termSummary.lastActivityAt,
						lastEditAt: schema.termSummary.lastEditAt,
					})
					.from(schema.termSummary)
					.where(inArray(schema.termSummary.slug, [...slugs])),
			);
			return rows.map(
				(r) =>
					({
						id: r.slug,
						slug: r.slug,
						title: r.title,
						count: r.definitionCount,
						totalScore: r.totalScore,
						excerpt: r.excerpt ?? null,
						firstAt: r.firstAt,
						lastEdit: r.lastEditAt,
						firstLetter: r.firstLetter,
						definitionCount: r.definitionCount,
						lastActivityAt: r.lastActivityAt,
					}) satisfies TermSummaryRow,
			);
		});

		const listTermSummaries = Effect.fn("Sozluk.listTermSummaries")(function* (
			opts: {sort?: ListSort; limit?: number} = {},
		) {
			const sort = opts.sort ?? "recent";
			const limit = opts.limit ?? 50;

			const rows = yield* run((db) =>
				db
					.select({
						slug: schema.termSummary.slug,
						title: schema.termSummary.title,
						firstLetter: schema.termSummary.firstLetter,
						definitionCount: schema.termSummary.definitionCount,
						totalScore: schema.termSummary.totalScore,
						excerpt: schema.termSummary.excerpt,
						firstAt: schema.termSummary.firstAt,
						lastActivityAt: schema.termSummary.lastActivityAt,
						lastEditAt: schema.termSummary.lastEditAt,
					})
					.from(schema.termSummary)
					.orderBy(
						sort === "popular"
							? desc(schema.termSummary.totalScore)
							: desc(schema.termSummary.lastActivityAt),
					)
					.limit(limit),
			);

			return rows.map(
				(r) =>
					({
						id: r.slug,
						slug: r.slug,
						title: r.title,
						count: r.definitionCount,
						totalScore: r.totalScore,
						excerpt: r.excerpt ?? null,
						firstAt: r.firstAt,
						lastEdit: r.lastEditAt,
						firstLetter: r.firstLetter,
						definitionCount: r.definitionCount,
						lastActivityAt: r.lastActivityAt,
					}) satisfies TermSummaryRow,
			);
		});

		const listTermSummariesConnection = Effect.fn("Sozluk.listTermSummariesConnection")(function* (
			opts: {sort?: ListSort; first?: number; after?: string | null} = {},
		) {
			const sort = opts.sort ?? "recent";
			const first = Math.max(1, Math.min(opts.first ?? 20, 100));
			const after = opts.after ?? null;

			const totalCount = yield* run((db) =>
				db
					.select({n: sql<number>`count(*)`})
					.from(schema.termSummary)
					.get()
					.then((r) => r?.n ?? 0),
			);

			let cursorRow: {
				slug: string;
				totalScore: number;
				lastActivityAt: Date | null;
			} | null = null;
			if (after) {
				cursorRow =
					(yield* run((db) =>
						db
							.select({
								slug: schema.termSummary.slug,
								totalScore: schema.termSummary.totalScore,
								lastActivityAt: schema.termSummary.lastActivityAt,
							})
							.from(schema.termSummary)
							.where(eq(schema.termSummary.slug, after))
							.get(),
					)) ?? null;
				if (!cursorRow) {
					return {
						rows: [],
						hasNextPage: false,
						endCursor: null,
						totalCount,
					} satisfies TermConnectionPage;
				}
			}

			// Lead column by sort (popular → totalScore desc, recent →
			// lastActivityAt desc), then the `slug` asc tiebreaker. A null
			// lastActivityAt cursor drops the lead column → slug-only keyset, the
			// same fallback as before.
			const lead =
				sort === "popular"
					? {
							column: schema.termSummary.totalScore,
							dir: "desc" as const,
							value: cursorRow?.totalScore ?? null,
						}
					: {
							column: schema.termSummary.lastActivityAt,
							dir: "desc" as const,
							value: cursorRow?.lastActivityAt ?? null,
						};
			const cursorPredicate = keysetAfter([
				lead,
				{column: schema.termSummary.slug, dir: "asc", value: cursorRow?.slug ?? null},
			]);

			const orderBy =
				sort === "popular"
					? [desc(schema.termSummary.totalScore), schema.termSummary.slug]
					: [desc(schema.termSummary.lastActivityAt), schema.termSummary.slug];

			const fetched = yield* run((db) =>
				db
					.select({
						slug: schema.termSummary.slug,
						title: schema.termSummary.title,
						firstLetter: schema.termSummary.firstLetter,
						definitionCount: schema.termSummary.definitionCount,
						totalScore: schema.termSummary.totalScore,
						excerpt: schema.termSummary.excerpt,
						firstAt: schema.termSummary.firstAt,
						lastActivityAt: schema.termSummary.lastActivityAt,
						lastEditAt: schema.termSummary.lastEditAt,
					})
					.from(schema.termSummary)
					.where(cursorPredicate)
					.orderBy(...orderBy)
					.limit(first + 1),
			);

			const page = forwardPage(
				fetched,
				first,
				(r: TermSummaryRow) => r.slug,
				(r) => ({
					id: r.slug,
					slug: r.slug,
					title: r.title,
					count: r.definitionCount,
					totalScore: r.totalScore,
					excerpt: r.excerpt ?? null,
					firstAt: r.firstAt,
					lastEdit: r.lastEditAt,
					firstLetter: r.firstLetter,
					definitionCount: r.definitionCount,
					lastActivityAt: r.lastActivityAt,
				}),
			);

			return {...page, totalCount} satisfies TermConnectionPage;
		});

		const readMyVote = Effect.fn("Sozluk.readMyVote")(function* (input: {
			userId: string;
			targetKind: "definition" | "post" | "comment";
			targetId: string;
		}) {
			const rows = yield* run((db) =>
				db
					.select({userId: schema.userVote.userId})
					.from(schema.userVote)
					.where(
						and(
							eq(schema.userVote.userId, input.userId),
							eq(schema.userVote.targetKind, input.targetKind),
							eq(schema.userVote.targetId, input.targetId),
						),
					)
					.limit(1),
			);
			return rows.length > 0 ? 1 : null;
		});

		const lookupDefinitionTermSlug = Effect.fn("Sozluk.lookupDefinitionTermSlug")(function* (
			definitionId: string,
		) {
			const rows = yield* run((db) =>
				db
					.select({termSlug: schema.definitionView.termSlug})
					.from(schema.definitionView)
					.where(eq(schema.definitionView.id, definitionId))
					.limit(1),
			);
			return rows[0]?.termSlug ?? null;
		});

		/* ------------------------------------------------------------------ */
		/* Mutations                                                           */
		/* ------------------------------------------------------------------ */

		const addDefinition = Effect.fn("Sozluk.addDefinition")(function* (input: AddDefinitionInput) {
			const rawBody = yield* validateBody(input.body);

			const slug = input.termSlug;
			const existing = yield* run((db) =>
				db.query.termSummary.findFirst({where: eq(schema.termSummary.slug, slug)}),
			);
			const termCreated = !existing;
			const title = existing?.title ?? input.termTitle ?? slug.replace(/-/g, " ");

			const definitionId = id("def");
			const now = new Date();
			const bodyExcerpt = excerpt(rawBody);

			yield* run((db) =>
				db.insert(schema.definitionView).values({
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
					deletedAt: null,
					lastEventId: "",
				}),
			);

			yield* recomputeTermSummary(slug, title, now);
			yield* recomputeSozlukStats(now);

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
				db.query.definitionView.findFirst({
					where: and(
						eq(schema.definitionView.id, input.definitionId),
						isNull(schema.definitionView.deletedAt),
					),
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
					.update(schema.definitionView)
					.set({body: rawBody, bodyExcerpt, updatedAt: now})
					.where(eq(schema.definitionView.id, input.definitionId)),
			);

			yield* recomputeTermSummary(definition.termSlug, definition.termTitle, now);

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

		/**
		 * SOFT delete: stamps `deletedAt`/`updatedAt` and recomputes the term
		 * summary + sözlük stats, but leaves the vote tables intact and does NOT
		 * reverse the author's karma. This diverges from `Pano.deletePost` (hard
		 * delete, karma reversed) — a deliberate, known inconsistency pending
		 * `.decisions/0024-delete-semantics-and-karma.md`. Read that ADR before
		 * "fixing" one path to match the other.
		 */
		const deleteDefinition = Effect.fn("Sozluk.deleteDefinition")(function* (
			input: DeleteDefinitionInput,
		) {
			const definition = yield* run((db) =>
				db.query.definitionView.findFirst({
					where: eq(schema.definitionView.id, input.definitionId),
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
			if (definition.deletedAt) {
				return {
					definitionId: input.definitionId,
					deleted: false,
				} satisfies DeleteDefinitionResult;
			}

			const now = new Date();
			yield* run((db) =>
				db
					.update(schema.definitionView)
					.set({deletedAt: now, updatedAt: now})
					.where(eq(schema.definitionView.id, input.definitionId)),
			);

			yield* recomputeTermSummary(definition.termSlug, definition.termTitle, now);
			yield* recomputeSozlukStats(now);

			return {
				definitionId: input.definitionId,
				deleted: true,
			} satisfies DeleteDefinitionResult;
		});

		/**
		 * Shared body for `voteDefinition` / `retractDefinitionVote`. Delegates
		 * to the shared `Vote.cast` for the atomic batch (vote insert/delete,
		 * score-cache update, `user_vote` mirror, karma bump), then recomputes
		 * `term_summary` aggregates after a state change.
		 *
		 * Translates `VoteTargetNotFound` from the Vote service into
		 * `DefinitionNotFound` so the resolver codec keeps producing
		 * `DEFINITION_NOT_FOUND` for this surface.
		 */
		const applyVote = Effect.fn("Sozluk.applyVote")(function* (
			input: VoteDefinitionInput,
			isVote: boolean,
		) {
			// Load definition meta up-front so we can return the canonical
			// resolver shape (body / author / timestamps) regardless of
			// changed/no-op path.
			const definition = yield* run((db) =>
				db.query.definitionView.findFirst({
					where: and(
						eq(schema.definitionView.id, input.definitionId),
						isNull(schema.definitionView.deletedAt),
					),
				}),
			);
			if (!definition) {
				return yield* new DefinitionNotFound({
					definitionId: input.definitionId,
					message: `definition ${input.definitionId} not found`,
				});
			}

			// Vote.cast may fail with VoteTargetNotFound on a race (definition
			// soft-deleted between our read and its own existence check). Map
			// that back to the sozluk-typed error.
			const voteResult = yield* voteSvc
				.cast({
					userId: input.voterId,
					targetKind: "definition",
					targetId: input.definitionId,
					value: isVote ? 1 : null,
				})
				.pipe(
					Effect.catchTag("vote/VoteTargetNotFound", (_e: VoteTargetNotFound) =>
						Effect.fail(
							new DefinitionNotFound({
								definitionId: input.definitionId,
								message: `definition ${input.definitionId} not found`,
							}),
						),
					),
				);

			const now = new Date();
			if (voteResult.changed) {
				// Vote already wrote definition_view.score inside its batch;
				// recomputeTermSummary re-reads that and refreshes the term
				// aggregates.
				yield* recomputeTermSummary(definition.termSlug, definition.termTitle, now);
			}

			return {
				definitionId: input.definitionId,
				score: voteResult.score,
				body: definition.body,
				authorId: definition.authorId,
				authorName: definition.authorName,
				createdAt: definition.createdAt ?? now,
				updatedAt: voteResult.changed ? now : (definition.updatedAt ?? now),
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
			return yield* applyVote(input, false);
		});

		return {
			getTerm,
			listDefinitionsKeyset,
			getDefinitionsByIds,
			getTermSummariesByIds,
			listTermSummaries,
			listTermSummariesConnection,
			readMyVote,
			lookupDefinitionTermSlug,
			addDefinition,
			editDefinition,
			deleteDefinition,
			voteDefinition,
			retractDefinitionVote,
		};
	}),
);
