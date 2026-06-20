/**
 * Sozluk — the dictionary feature service: term reads + definition CRUD +
 * connection-shaped pagination.
 *
 * Vote mutations delegate to the shared `Vote.cast` (atomic vote write + karma)
 * and only recompute `term_summary` aggregates afterward, rather than
 * reimplementing the batch-vote logic. Validation lives in the service methods
 * as closure helpers (ADR 0013).
 */
import {id} from "@usirin/forge";
import {and, asc, desc, eq, inArray, isNull, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {emptyKeysetPage, forwardPage, keysetAfter, resolveCursor} from "../../db/keyset.ts";
import {syncTermSearch} from "../search/fts-sync.ts";
import {excerpt as excerptText} from "../text/index.ts";
import type {VoteTargetNotFound} from "../vote/errors.ts";
import {Vote} from "../vote/Vote.ts";
import {
	type DefinitionConnectionPage,
	type DefinitionRow,
	type TermPage,
	toDefinitionRow,
} from "./definition-row.ts";
import {
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
} from "./errors.ts";
import {
	type TermConnectionPage,
	type TermSummaryRow,
	termSummaryColumns,
	toTermSummaryRow,
} from "./term-summary.ts";

export type {DefinitionConnectionPage, DefinitionRow, TermPage} from "./definition-row.ts";
export type {TermConnectionPage, TermSummaryRow} from "./term-summary.ts";

/** Body length cap for definitions — surfaced as `BODY_TOO_LONG` on overflow. */
export const DEFINITION_BODY_MAX = 10_000;

const DEFINITION_EXCERPT_LEN = 140;

const excerpt = (body: string): string => excerptText(body, DEFINITION_EXCERPT_LEN);

/** Earliest `createdAt` across a slice (the term's `first_at`), or `null`. */
const earliestCreatedAt = (defs: ReadonlyArray<{createdAt: Date | null}>): Date | null =>
	defs.reduce<Date | null>((acc, d) => {
		const c = d.createdAt;
		if (!c) return acc;
		return acc && acc < c ? acc : c;
	}, null);

/** Latest `updatedAt ?? createdAt` across a slice (the term's `last_edit_at`), or `null`. */
const latestEditAt = (
	defs: ReadonlyArray<{createdAt: Date | null; updatedAt: Date | null}>,
): Date | null =>
	defs.reduce<Date | null>((acc, d) => {
		const u = d.updatedAt ?? d.createdAt;
		if (!u) return acc;
		return acc && acc > u ? acc : u;
	}, null);

export type ListSort = "recent" | "popular";

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

export class Sozluk extends Context.Service<
	Sozluk,
	{
		readonly getTerm: (slug: string) => Effect.Effect<TermPage | null>;

		/**
		 * DB-keyset page of a term's live definitions in the canonical
		 * `(score desc, created_at asc, id asc)` term-page order. The cursor is a
		 * definition id and the keyset predicate fetches the rows after it, so a
		 * page is a bounded `WHERE … LIMIT`, not a full load. `viewerId` batches
		 * `myVote` for the whole page in one `user_vote` read.
		 */
		readonly listDefinitionsKeyset: (
			slug: string,
			opts?: {
				first?: number | undefined;
				after?: string | null | undefined;
				viewerId?: string | null | undefined;
			},
		) => Effect.Effect<DefinitionConnectionPage>;

		/**
		 * Batched read of definitions by id (the `Definition` source's `byIds`
		 * workhorse — avoids the relation N+1). `viewerId` stamps `myVote` for the
		 * whole batch in one query. Soft-deleted rows skipped; order not guaranteed
		 * (fate re-associates by id).
		 */
		readonly getDefinitionsByIds: (
			ids: ReadonlyArray<string>,
			opts?: {viewerId?: string | null | undefined},
		) => Effect.Effect<DefinitionRow[]>;

		/** Batched read of term summaries by slug; order not guaranteed (fate re-associates by id). */
		readonly getTermSummariesByIds: (
			slugs: ReadonlyArray<string>,
		) => Effect.Effect<TermSummaryRow[]>;

		readonly listTermSummaries: (opts?: {
			sort?: ListSort;
			limit?: number;
		}) => Effect.Effect<TermSummaryRow[]>;

		readonly listTermSummariesConnection: (opts?: {
			sort?: ListSort;
			first?: number;
			after?: string | null;
		}) => Effect.Effect<TermConnectionPage>;

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

		readonly voteDefinition: (
			input: VoteDefinitionInput,
		) => Effect.Effect<VoteDefinitionResult, DefinitionNotFound>;

		readonly retractDefinitionVote: (
			input: VoteDefinitionInput,
		) => Effect.Effect<VoteDefinitionResult, DefinitionNotFound>;
	}
>()("@kampus/sozluk/Sozluk") {}

export const SozlukLive = Layer.effect(Sozluk)(
	Effect.gen(function* () {
		// Drizzle is taken through `orDieAccess`: every DB call site dies on
		// `DrizzleError` (infra failures are defects — the domain-boundary rule),
		// so public signatures carry domain errors only and every method's `R`
		// stays `never`.
		const {run} = orDieAccess(yield* Drizzle);
		const voteSvc = yield* Vote;

		// Per ADR 0013, body validation lives here, not in the resolver. Returns
		// the trimmed body when valid, else fails with the tagged error.
		const validateBody = Effect.fn("Sozluk.validateBody")(function* (
			body: string | null | undefined,
		) {
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

		// Recompute one slug's `term_summary` row from its live `definition_view`
		// slice. Convergent: the row is fully derived from definitions + title.
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
			const firstAt = earliestCreatedAt(defs) ?? now;
			const lastEditAt = latestEditAt(defs) ?? now;

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

			// Dual-write the term's FTS row in lockstep with its summary (ADR 0080).
			// `recomputeTermSummary` is the single convergent point every term write
			// funnels through, so syncing here keeps `term_search` current across
			// add/edit/delete/vote with one wiring.
			for (const stmt of syncTermSearch(slug, title)) {
				yield* run((db) => db.run(stmt));
			}
		});

		// Refresh `sozluk_stats` totals; runs after every write that could affect them.
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

		const getTerm = Effect.fn("Sozluk.getTerm")(function* (slug: string) {
			const meta = yield* run((db) => db.query.termSummary.findFirst({where: {slug}}));
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

			// Resolve the opaque `after` to its keyset tuple. The DB read is the port;
			// `resolveCursor` is the pure cursor-miss decision (ADR 0082).
			const resolvedRow = after
				? ((yield* run((db) =>
						db
							.select({
								score: schema.definitionView.score,
								createdAt: schema.definitionView.createdAt,
							})
							.from(schema.definitionView)
							.where(eq(schema.definitionView.id, after))
							.get(),
					)) ?? null)
				: null;
			const cursor = resolveCursor(after, resolvedRow);
			if (cursor.kind === "miss") {
				return {...emptyKeysetPage, totalCount} satisfies DefinitionConnectionPage;
			}
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

			// Mixed-direction keyset, declared per column; `keysetAfter` builds the
			// lexicographic predicate.
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

			const voted = yield* voteSvc.readMine(
				viewerId,
				"definition",
				fetched.slice(0, first).map((d) => d.id),
			);
			const page = forwardPage(
				fetched,
				first,
				(r: DefinitionRow) => r.id,
				(d) => toDefinitionRow(d, voted, viewerId),
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
			const voted = yield* voteSvc.readMine(
				viewerId,
				"definition",
				fetched.map((d) => d.id),
			);
			return fetched.map((d) => toDefinitionRow(d, voted, viewerId));
		});

		const getTermSummariesByIds = Effect.fn("Sozluk.getTermSummariesByIds")(function* (
			slugs: ReadonlyArray<string>,
		) {
			if (slugs.length === 0) return [];
			const rows = yield* run((db) =>
				db
					.select(termSummaryColumns)
					.from(schema.termSummary)
					.where(inArray(schema.termSummary.slug, [...slugs])),
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
					.from(schema.termSummary)
					.orderBy(
						sort === "popular"
							? desc(schema.termSummary.totalScore)
							: desc(schema.termSummary.lastActivityAt),
					)
					.limit(limit),
			);

			return rows.map(toTermSummaryRow);
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

			type CursorRow = {slug: string; totalScore: number; lastActivityAt: Date | null};
			const resolvedRow = after
				? ((yield* run((db) =>
						db
							.select({
								slug: schema.termSummary.slug,
								totalScore: schema.termSummary.totalScore,
								lastActivityAt: schema.termSummary.lastActivityAt,
							})
							.from(schema.termSummary)
							.where(eq(schema.termSummary.slug, after))
							.get(),
					)) ?? null)
				: null;
			const cursor = resolveCursor<CursorRow>(after, resolvedRow);
			if (cursor.kind === "miss") {
				return {...emptyKeysetPage, totalCount} satisfies TermConnectionPage;
			}
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

			// Lead column by sort, then the `slug` asc tiebreaker. A null
			// lastActivityAt cursor drops the lead column → slug-only keyset.
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
					.select(termSummaryColumns)
					.from(schema.termSummary)
					.where(cursorPredicate)
					.orderBy(...orderBy)
					.limit(first + 1),
			);

			const page = forwardPage(fetched, first, (r) => r.slug, toTermSummaryRow);

			return {...page, totalCount} satisfies TermConnectionPage;
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

		const addDefinition = Effect.fn("Sozluk.addDefinition")(function* (input: AddDefinitionInput) {
			const rawBody = yield* validateBody(input.body);

			const slug = input.termSlug;
			const existing = yield* run((db) => db.query.termSummary.findFirst({where: {slug}}));
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
					where: {id: input.definitionId, deletedAt: {isNull: true}},
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

		// Shared body for `voteDefinition` / `retractDefinitionVote`. Delegates to
		// `Vote.cast` for the atomic batch, then recomputes `term_summary`
		// aggregates after a state change. Translates `VoteTargetNotFound` into
		// `DefinitionNotFound` so this surface keeps emitting `DEFINITION_NOT_FOUND`.
		const applyVote = Effect.fn("Sozluk.applyVote")(function* (
			input: VoteDefinitionInput,
			isVote: boolean,
		) {
			// Load meta up-front so we can return the canonical resolver shape
			// regardless of the changed/no-op path.
			const definition = yield* run((db) =>
				db.query.definitionView.findFirst({
					where: {id: input.definitionId, deletedAt: {isNull: true}},
				}),
			);
			if (!definition) {
				return yield* new DefinitionNotFound({
					definitionId: input.definitionId,
					message: `definition ${input.definitionId} not found`,
				});
			}

			// Vote.cast can fail with VoteTargetNotFound on a race (definition
			// soft-deleted between our read and its existence check); map it back.
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
				// Vote already wrote definition_view.score in its batch; this re-reads
				// it to refresh the term aggregates.
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
			lookupDefinitionTermSlug,
			addDefinition,
			editDefinition,
			deleteDefinition,
			voteDefinition,
			retractDefinitionVote,
		};
	}),
);
