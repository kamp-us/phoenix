/**
 * Sozluk — the dictionary feature service: term reads + definition CRUD +
 * connection-shaped pagination.
 *
 * Vote mutations delegate to the shared `Vote.cast` (atomic vote write + karma)
 * and only recompute `term_record` aggregates afterward, rather than
 * reimplementing the batch-vote logic. Pure validation/derivation is module-private;
 * its wire codes unit-test off-DB THROUGH the mutation (ADR 0013 / 0082).
 */
import {id} from "@usirin/forge";
import {and, asc, desc, eq, inArray, isNull, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {emptyKeysetPage, forwardPage, keysetAfter, resolveCursor} from "../../db/keyset.ts";
import {keysetKeys, orderByColumns} from "../../db/ordering.ts";
import {stampViewerScalars} from "../fate/viewer-scalars.ts";
import * as Removal from "../lifecycle/removal.ts";
import {syncTermSearch} from "../search/fts-sync.ts";
import {excerpt as excerptText} from "../text/index.ts";
import type {VoteTargetNotFound} from "../vote/errors.ts";
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
import {
	type TermConnectionPage,
	type TermSummaryRow,
	termSummaryColumns,
	toTermSummaryRow,
} from "./term-summary.ts";

export type {DefinitionConnectionPage, DefinitionRow, TermPage} from "./definition-fields.ts";
export type {TermConnectionPage, TermSummaryRow} from "./term-summary.ts";

/** Body length cap for definitions — surfaced as `BODY_TOO_LONG` on overflow. */
export const DEFINITION_BODY_MAX = 10_000;

// Pure validation/derivation lifted off the service (ADR 0013 for *where*, ADR
// 0082 for *why*): each is wrong-or-right on its input with no DB. They're
// module-private; the wire codes unit-test off-DB THROUGH the mutation
// (`definition-validation.unit.test.ts` drives `addDefinition` / `editDefinition`
// over a throwing `Drizzle`, proving the gate fires before any DB call).
// `addDefinition` / `editDefinition` call these at the same point the in-factory
// closure / inline `replace` ran, so observable behavior is unchanged.

/**
 * Per ADR 0013, body validation lives in the domain, not the resolver. Returns
 * the body when valid (empty after trim ⇒ `BodyRequired`, over the cap ⇒
 * `BodyTooLong`).
 */
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

/** Fallback term title when none is supplied: the slug with dashes as spaces. */
const titleFromSlug = (slug: string): string => slug.replace(/-/g, " ");

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

// The term-summary list sort — defined with the orderings it selects (`ordering.ts`).
export type ListSort = TermSummarySort;

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
	/** `true` if the voter holds an upvote on this definition after the write. */
	myVote: boolean;
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
	/**
	 * Why the definition is being removed (ADR 0096). Defaults to `AuthorDeletion`
	 * — the author-delete mutation passes nothing; account-deletion (0097) and
	 * moderation (0098) pass `Anonymized` / `Moderated({reportId})`.
	 */
	reason?: Removal.RemovalReason;
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

		/** Un-remove a `Removed` definition (ADR 0096 §4). Votes stay wiped. */
		readonly restoreDefinition: (
			input: DeleteDefinitionInput,
		) => Effect.Effect<DeleteDefinitionResult, DefinitionNotFound | UnauthorizedDefinitionMutation>;

		/**
		 * Moderator soft-delete (ADR 0098 §6) — the same 0096 substrate write as
		 * `deleteDefinition`, but gated on discharged moderator authority (the caller
		 * proved `Moderator.required`), NOT author ownership: `removed_by` is the
		 * resolver and the reason is `Moderated({reportId})`. A missing target is a
		 * no-op (`removed: false`), so resolving a stale report can't fail.
		 */
		readonly moderateRemoveDefinition: (input: {
			definitionId: string;
			resolverId: string;
			reportId: string;
		}) => Effect.Effect<{removed: boolean}>;

		/** Moderator restore (ADR 0098 §3) — reopens the report at the resolve layer. */
		readonly moderateRestoreDefinition: (input: {
			definitionId: string;
		}) => Effect.Effect<{restored: boolean}>;

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
		const {run, batch} = orDieAccess(yield* Drizzle);
		const voteSvc = yield* Vote;

		// The removal-sequence owner (#1129): the vote-wipe→stamp ordering is the
		// module's to enforce, not this service's to hand-wire.
		const removalSeq: Removal.RemovalSequence = {run, batch, clearTarget: voteSvc.clearTarget};

		// `Definition`'s one viewer scalar: `myVote` from the batched `user_vote`
		// presence read. Every definition read finalizes through `stampViewerScalars`
		// with this spec, so the batch-read-then-stamp contract can't be forgotten (#1126).
		const definitionVoteScalar = {
			field: "myVote",
			read: (viewerId: string | null | undefined, ids: ReadonlyArray<string>) =>
				voteSvc.readMine(viewerId, "definition", ids),
		} as const;

		// Recompute one slug's `term_record` row from its live `definition_record`
		// slice. Convergent: the row is fully derived from definitions + title.
		const recomputeTermSummary = Effect.fn("Sozluk.recomputeTermSummary")(function* (
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
						),
					)
					.orderBy(desc(schema.definitionRecord.score), asc(schema.definitionRecord.createdAt)),
			);

			const totalScore = defs.reduce((s, d) => s + d.score, 0);
			const top = defs[0];
			const topExcerpt = top ? top.bodyExcerpt || excerpt(top.body) : null;
			const firstLetter = slug.charAt(0).toLowerCase();
			const firstAt = earliestCreatedAt(defs) ?? now;
			const lastEditAt = latestEditAt(defs) ?? now;

			// Summary upsert + its FTS dual-write in ONE batch so they move
			// all-or-none (ADR 0080 lockstep): a crash between the two can never
			// desync `term_search` from `term_record`. `recomputeTermSummary` is
			// the single convergent point every term write funnels through, so this
			// keeps `term_search` current across add/edit/delete/vote with one wiring.
			// Both items are drizzle query builders, NOT `db.run(sql)`: a batch item
			// must `_prepare()` to a `D1PreparedQuery` with a bound `.stmt`, which a
			// parametrized `db.run(sql\`…\`)` (a `SQLiteRaw`) lacks — it 500s the whole
			// batch on real D1 (#863). The builder prepares batch-safe.
			yield* batch((db) => [
				db
					.insert(schema.termRecord)
					.values({
						slug,
						title,
						firstLetter,
						definitionCount: defs.length,
						totalScore,
						excerpt: topExcerpt,
						topDefinitionId: top?.id ?? null,
						firstAt,
						lastActivityAt: now,
						lastEditAt,
						lastEventId: "",
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

		// Refresh `sozluk_stats` totals; runs after every write that could affect them.
		const recomputeSozlukStats = Effect.fn("Sozluk.recomputeSozlukStats")(function* (now: Date) {
			const totalTermsRow = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.termRecord)
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			const totalDefsRow = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.definitionRecord)
					.where(isNull(schema.definitionRecord.removedAt))
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			const totalAuthorsRow = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(DISTINCT ${schema.definitionRecord.authorId})`})
					.from(schema.definitionRecord)
					.where(isNull(schema.definitionRecord.removedAt))
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
			const meta = yield* run((db) => db.query.termRecord.findFirst({where: {slug}}));
			if (!meta) return null;

			const defs = yield* run((db) =>
				db
					.select()
					.from(schema.definitionRecord)
					.where(
						and(
							eq(schema.definitionRecord.termSlug, slug),
							isNull(schema.definitionRecord.removedAt),
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
			} = {},
		) {
			const first = Math.max(1, Math.min(opts.first ?? 50, 200));
			const after = opts.after ?? null;
			const viewerId = opts.viewerId ?? null;

			const baseWhere = and(
				eq(schema.definitionRecord.termSlug, slug),
				isNull(schema.definitionRecord.removedAt),
			);
			const totalCount = yield* run((db) =>
				db
					.select({n: sql<number>`count(*)`})
					.from(schema.definitionRecord)
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

			// Mixed-direction keyset; `keysetAfter` builds the lexicographic predicate.
			// Both the predicate and `orderBy` derive from `DEFINITION_ORDERING`: the
			// `id` cursor value is the opaque `after` itself (the resolved row carries
			// only `score`/`createdAt`).
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

			const page = forwardPage(fetched, first, (r: DefinitionRow) => r.id, toDefinitionRow);
			const rows = yield* stampViewerScalars(page.rows, viewerId, [definitionVoteScalar]);

			return {...page, rows, totalCount} satisfies DefinitionConnectionPage;
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
					.from(schema.definitionRecord)
					.where(
						and(
							inArray(schema.definitionRecord.id, [...ids]),
							isNull(schema.definitionRecord.removedAt),
						),
					),
			);
			return yield* stampViewerScalars(fetched.map(toDefinitionRow), viewerId, [
				definitionVoteScalar,
			]);
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
			opts: {sort?: ListSort; first?: number; after?: string | null} = {},
		) {
			const sort = opts.sort ?? "recent";
			const first = Math.max(1, Math.min(opts.first ?? 20, 100));
			const after = opts.after ?? null;

			const totalCount = yield* run((db) =>
				db
					.select({n: sql<number>`count(*)`})
					.from(schema.termRecord)
					.get()
					.then((r) => r?.n ?? 0),
			);

			type CursorRow = {slug: string; totalScore: number; lastActivityAt: Date | null};
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

			// Lead column + `slug` asc tiebreaker, single-sourced per sort: both the
			// keyset predicate and `orderBy` derive from `TERM_SUMMARY_ORDERING[sort]`.
			// A null lastActivityAt cursor value drops the lead column → slug-only keyset.
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
					.where(cursorPredicate)
					.orderBy(...orderByColumns(ordering))
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

		// Remove → restore both flow through the ADR 0096 substrate: stamp the
		// `Removed` triad (`Vote.clearTarget` wipes votes, karma KEPT), or clear it
		// back to `Live`. The lifecycle is the projection of the three columns
		// (`Removal.fromColumns`); the term summary + sözlük stats are recomputable
		// caches refreshed outside the cleanup batch (ADR 0011).
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
			if (Removal.isRemoved(Removal.fromColumns(definition))) {
				return {
					definitionId: input.definitionId,
					deleted: false,
				} satisfies DeleteDefinitionResult;
			}

			const now = new Date();
			const removed = Removal.toColumns(
				Removal.remove({
					removedAt: now,
					removedBy: input.actorId,
					reason: input.reason ?? new Removal.AuthorDeletion(),
				}),
			);
			yield* Removal.removeEntity(
				removalSeq,
				{kind: "definition", id: input.definitionId},
				removed,
				now,
			);

			yield* recomputeTermSummary(definition.termSlug, definition.termTitle, now);
			yield* recomputeSozlukStats(now);

			return {
				definitionId: input.definitionId,
				deleted: true,
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
			const lifecycle = Removal.fromColumns(definition);
			if (!Removal.isRemoved(lifecycle)) {
				return {definitionId: input.definitionId, deleted: false} satisfies DeleteDefinitionResult;
			}

			const now = new Date();
			// `Removal.restore : Removed → Live` clears the triad; votes wiped on
			// removal are NOT resurrected (ADR 0096 §4), so the score cache stays 0.
			const live = Removal.toColumns(Removal.restore(lifecycle));
			yield* Removal.restoreEntity(
				removalSeq,
				{kind: "definition", id: input.definitionId},
				live,
				now,
			);

			yield* recomputeTermSummary(definition.termSlug, definition.termTitle, now);
			yield* recomputeSozlukStats(now);

			return {definitionId: input.definitionId, deleted: true} satisfies DeleteDefinitionResult;
		});

		const moderateRemoveDefinition = Effect.fn("Sozluk.moderateRemoveDefinition")(
			function* (input: {definitionId: string; resolverId: string; reportId: string}) {
				const definition = yield* run((db) =>
					db.query.definitionRecord.findFirst({where: {id: input.definitionId}}),
				);
				if (!definition || Removal.isRemoved(Removal.fromColumns(definition))) {
					return {removed: false};
				}

				const now = new Date();
				const removed = Removal.toColumns(
					Removal.remove({
						removedAt: now,
						removedBy: input.resolverId,
						reason: new Removal.Moderated({reportId: input.reportId}),
					}),
				);
				yield* Removal.removeEntity(
					removalSeq,
					{kind: "definition", id: input.definitionId},
					removed,
					now,
				);

				yield* recomputeTermSummary(definition.termSlug, definition.termTitle, now);
				yield* recomputeSozlukStats(now);

				return {removed: true};
			},
		);

		const moderateRestoreDefinition = Effect.fn("Sozluk.moderateRestoreDefinition")(
			function* (input: {definitionId: string}) {
				const definition = yield* run((db) =>
					db.query.definitionRecord.findFirst({where: {id: input.definitionId}}),
				);
				if (!definition) return {restored: false};
				const lifecycle = Removal.fromColumns(definition);
				if (!Removal.isRemoved(lifecycle)) return {restored: false};

				const now = new Date();
				const live = Removal.toColumns(Removal.restore(lifecycle));
				yield* Removal.restoreEntity(
					removalSeq,
					{kind: "definition", id: input.definitionId},
					live,
					now,
				);

				yield* recomputeTermSummary(definition.termSlug, definition.termTitle, now);
				yield* recomputeSozlukStats(now);

				return {restored: true};
			},
		);

		// Shared body for `voteDefinition` / `retractDefinitionVote`. Delegates to
		// `Vote.cast` for the atomic batch, then recomputes `term_record`
		// aggregates after a state change. Translates `VoteTargetNotFound` into
		// `DefinitionNotFound` so this surface keeps emitting `DEFINITION_NOT_FOUND`.
		const applyVote = Effect.fn("Sozluk.applyVote")(function* (
			input: VoteDefinitionInput,
			isVote: boolean,
		) {
			// Load meta up-front so we can return the canonical resolver shape
			// regardless of the changed/no-op path.
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

			// Vote.cast can fail with VoteTargetNotFound on a race (definition
			// soft-deleted between our read and its existence check); map it back.
			const voteResult = yield* voteSvc
				.cast({
					userId: input.voterId,
					targetKind: "definition",
					targetId: input.definitionId,
					value: isVote,
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
				// Vote already wrote definition_record.score in its batch; this re-reads
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
			restoreDefinition,
			moderateRemoveDefinition,
			moderateRestoreDefinition,
			voteDefinition,
			retractDefinitionVote,
		};
	}),
);
