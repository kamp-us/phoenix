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
	sandboxVisibleWhere,
} from "../lifecycle/SandboxVisibility.ts";
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
import {
	type TermConnectionPage,
	type TermSummaryRow,
	termSummaryColumns,
	toTermSummaryRow,
} from "./term-fields.ts";

export type {DefinitionConnectionPage, DefinitionRow, TermPage} from "./definition-fields.ts";
export type {TermConnectionPage, TermSummaryRow} from "./term-fields.ts";

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

/** One live-definition row the term-summary fold reads (the `recomputeTermSummary` select). */
export interface TermSummaryDefRow {
	id: string;
	body: string;
	bodyExcerpt: string | null;
	score: number;
	createdAt: Date | null;
	updatedAt: Date | null;
}

/** The fully-derived `term_record` aggregate the upsert consumes — no DB, no Effect. */
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
 * Pure convergent fold: a term's `term_record` aggregate is fully derived from
 * its live definitions + title (ADR 0082 — the decision lifted above the Drizzle
 * seam). `rows` MUST already be in term-page order `(score desc, created_at asc)`
 * so `rows[0]` is the top definition. `now` is the empty-slice fallback for
 * `firstAt` / `lastEditAt`.
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

/**
 * The backstop-reconciliation chunk size (#2558): the slug-keyset page width the periodic
 * sweep pages `term_record` in. Sized well above the v1 cohort so today's pass is a single
 * short page, while the bound holds as the table grows — mirrors `HOT_SCORE_DECAY_CHUNK`.
 */
export const SOZLUK_RECONCILE_CHUNK = 200;

/** One term the reconciliation sweep re-converges: the slug + its stored title. */
export interface TermRef {
	readonly slug: string;
	readonly title: string;
}

/**
 * The DB seam the reconciliation sweep drives (#2558), factored so {@link scanReconcileChunks}'s
 * cursor-advance + full-coverage control flow is unit-testable over in-memory ports (ADR 0082
 * litmus — wrong-or-right with no SQL engine). `fetchChunk(afterSlug, limit)` returns up to
 * `limit` term rows with `slug > afterSlug` in ascending slug order (`null` ⇒ from the head);
 * `refreshTerm` re-runs the convergent cache refresh for one term.
 */
export interface SozlukReconcileScanPorts {
	readonly fetchChunk: (
		afterSlug: string | null,
		limit: number,
	) => Effect.Effect<ReadonlyArray<TermRef>>;
	readonly refreshTerm: (term: TermRef) => Effect.Effect<void>;
}

/**
 * Keyset-chunk the backstop reconciliation sweep (#2558): page slug-ordered slices of at most
 * `chunkSize` terms, re-running the convergent refresh for each before fetching the next, so no
 * single query materializes the whole `term_record` table (mirrors the #2559 decay-sweep bound).
 * Every term is visited each pass — the slug-keyset cursor bounds each page, it never excludes a
 * term. Loops until a short (`< chunkSize`) page marks the tail; an exact-multiple table takes
 * one extra empty page to terminate. Returns the pass's scanned count.
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

// The term-summary list sort — defined with the orderings it selects (`ordering.ts`).
export type ListSort = TermSummarySort;

export interface AddDefinitionInput {
	termSlug: TermSlug;
	authorId: UserId;
	authorName: string;
	body: string;
	/** Optional human title. Falls back to slug-with-spaces. */
	termTitle?: string | undefined;
	/**
	 * The çaylak mod-only sandbox stamp (#1205), decided by the resolver from the
	 * authorship flag + author tier. `null`/absent ⇒ created live (today's behavior).
	 */
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

// `definitionId` and `voterId` are distinct brands (DefinitionId vs UserId), so
// transposing them at a call site is a compile error — the #2712 arg-swap the
// bare-`string` shape allowed is now unrepresentable.
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
	/** `true` if the voter holds an upvote on this definition after the write. */
	myVote: boolean;
	/** `true` if the vote-row state changed; `false` on idempotent no-op. */
	changed: boolean;
}

export interface ReactDefinitionInput {
	definitionId: DefinitionId;
	reactorId: UserId;
	/**
	 * The reaction intent, a curated-`REACTION_EMOJI` member or a retract. A palette
	 * emoji sets/changes the reactor's single reaction; `null` retracts it. The type
	 * only admits a palette member, so a non-palette string is already rejected by
	 * `ReactionEmojiSchema` at the wire boundary — this method never sees one.
	 */
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
	/**
	 * On a restore, the `sandboxedAt` the definition landed back at (#1811): `null` ⇒
	 * restored to `Live` (broadcast `alwaysLive`); non-null ⇒ restored to the çaylak
	 * sandbox, so the mutation suppresses the live echo via `decidePublish`. Absent on
	 * a delete result.
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
		 * DB-keyset page of a term's live definitions in the canonical
		 * `(score desc, created_at asc, id asc)` term-page order. The cursor is a
		 * definition id and the keyset predicate fetches the rows after it, so a
		 * page is a bounded `WHERE … LIMIT`, not a full load. `viewerId` batches
		 * `myVote` for the whole page in one `user_vote` read; `sandboxViewer`
		 * filters the çaylak sandbox (#1205) per the same viewer.
		 */
		readonly listDefinitionsKeyset: (
			slug: string,
			opts?: {
				first?: number | undefined;
				after?: string | null | undefined;
				viewerId?: string | null | undefined;
				sandboxViewer?: SandboxViewer | undefined;
				/**
				 * Route the page's independent stamps (viewer scalars + reaction aggregate +
				 * author identity) through the concurrent {@link parallelStampWave} instead of
				 * the serial chain (#2709). Default/off ⇒ the wave runs at `concurrency: 1`
				 * (serial, byte-for-byte today); the resolver flips it from the containment
				 * flag. Output is identical either way — only wall time collapses.
				 */
				parallelStamps?: boolean | undefined;
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
			opts?: {
				viewerId?: string | null | undefined;
				sandboxViewer?: SandboxViewer | undefined;
				/** See {@link listDefinitionsKeyset}'s `parallelStamps` (#2709). */
				parallelStamps?: boolean | undefined;
			},
		) => Effect.Effect<DefinitionRow[]>;

		/**
		 * The moderator sandbox-queue / promotion-backlog read model (#1205, the
		 * #1206 seam): a çaylak's still-sandboxed, not-removed definitions — scoped to
		 * one author when promotion flips their backlog. Authority (moderator) is
		 * gated at the resolver; the service read itself is unconditional.
		 */
		readonly listSandboxedDefinitions: (opts?: {
			authorId?: string | undefined;
		}) => Effect.Effect<DefinitionRow[]>;

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

		/**
		 * The public landing "sözlüğe son eklenenler" read (#1424): the most recent
		 * terms, scoped to LIVE content. A term surfaces only via a not-removed,
		 * not-sandboxed definition — the same record-level `removed_at IS NULL AND
		 * sandboxed_at IS NULL` mask the public `landingStats` counts carry (#1391,
		 * #1205) — so a çaylak's sandbox-only term never leaks onto the public front
		 * door, even one whose `term_record` summary row exists with a zero live count.
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
		 * Moderator soft-delete (ADR 0098 §6) — the same 0096 substrate write as
		 * `deleteDefinition`, but gated on discharged moderator authority (the caller
		 * holds a `Moderate` grant — the `moderates` relation tuple, ADR 0107 §4), NOT
		 * author ownership: `removed_by` is the
		 * resolver and the reason is `Moderated({reportId})`. A missing target is a
		 * no-op (`removed: false`), so resolving a stale report can't fail.
		 */
		readonly moderateRemoveDefinition: (input: {
			definitionId: string;
			resolverId: string;
			reportId: ReportId;
		}) => Effect.Effect<{removed: boolean}>;

		/**
		 * Moderator restore (ADR 0098 §3) — reopens the report at the resolve layer.
		 * `sandboxedAt` is the round-tripped sandbox marker (#1811) so report's live
		 * re-append gates the term-connection broadcast (a sandboxed restore stays
		 * suppressed, #1205/#1280).
		 */
		readonly moderateRestoreDefinition: (input: {
			definitionId: string;
		}) => Effect.Effect<{restored: boolean; sandboxedAt: Date | null}>;

		// `VoterNotEligible` (#1810): a çaylak newcomer's cast is rejected by the "earn to
		// vote" gate in `Vote.castImpl`. `SelfVoteNotAllowed` (#2216): a cast on one's own
		// definition is rejected at the cast site. Both cast path only — retraction raises
		// neither, so `retractDefinitionVote` keeps its `DefinitionNotFound` channel.
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
		 * Set / change / retract the reactor's single reaction on a definition (epic
		 * #1840, #1865) — the cross-product twin of `voteDefinition`, delegating to the
		 * shared {@link Reaction} engine instead of {@link Vote}. UNGATED and karma-free
		 * by construction: it takes no voter tier, writes no karma, and dispatches
		 * through `Reaction.react` (the settled divergence from vote — a çaylak may
		 * react, #1861). A palette `emoji` sets or replaces the reaction; `null`
		 * retracts it; cardinality-one (one reaction per (reactor, definition)) is the
		 * `user_reaction` PK, enforced in the engine. Returns the re-resolved
		 * `DefinitionRow` carrying the FRESH reaction aggregate + the reactor's own
		 * reaction (the `myVote`/`reactions` stamps every definition read shares).
		 * Translates the engine's target-miss into this surface's `DefinitionNotFound`.
		 */
		readonly reactToDefinition: (
			input: ReactDefinitionInput,
		) => Effect.Effect<DefinitionRow, DefinitionNotFound>;

		/**
		 * Backstop reconciliation (#2558): re-run the recomputable-cache refresh
		 * (`persistTermSummary` — the term summary + its `term_search` FTS dual-write — and
		 * `recomputeSozlukStats`) for EVERY sözlük term, so a term/stat left stale by a
		 * swallowed last-write refresh (`swallowRefresh`, #2012) is eventually re-converged
		 * WITHOUT waiting for a next user write. Driven by a periodic cron trigger
		 * (`sozluk-reconcile-cron.ts`); the request-path swallow is unchanged — this is the
		 * additive long-tail backstop. The sweep pages `term_record` in slug-keyset chunks
		 * (`scanReconcileChunks`). Idempotent: `persistTermSummary` is a pure convergent fold,
		 * so re-running it on an already-fresh term rewrites the identical row. Returns the
		 * pass's scanned count for observability.
		 */
		readonly reconcileCaches: (now: Date) => Effect.Effect<{readonly scanned: number}>;
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
		const reactionSvc = yield* Reaction;
		// Live author-identity resolver (#2139): one batched `user_profile` read per page
		// (`getProfileIdentitiesByIds`) stamps the CURRENT `{username, displayName}` so the
		// read surfaces render via `actorLabel`, not the write-time `authorName` snapshot.
		const pasaport = yield* Pasaport;

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

		// The three independent finalize stamps every definition read shares — `myVote`
		// (viewer scalar), the reaction aggregate, live author identity — each independent
		// given the fetched rows. `parallelStampWave` runs them over the SAME rows and
		// merges; `parallelStamps` picks the concurrency: off ⇒ `1` (serial, byte-for-byte
		// today), on ⇒ `"unbounded"` (one wave, the #2709 collapse). The reaction stamp's
		// own two D1 reads inherit the same knob so the whole wave is one phase when on.
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

		// Recompute one slug's `term_record` row from its live `definition_record`
		// slice. The closure is just the port: read rows via `run`, call the pure
		// `recomputeTermSummary` fold (module scope), write via `batch`.
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
							// The public term card (excerpt / top definition / count) must
							// reflect only LIVE content — a sandboxed çaylak definition (#1205)
							// is pending, never surfaced in the public denormalized aggregate.
							isNull(schema.definitionRecord.sandboxedAt),
						),
					)
					.orderBy(desc(schema.definitionRecord.score), asc(schema.definitionRecord.createdAt)),
			);

			const summary = recomputeTermSummary(defs, slug, title, now);

			// Summary upsert + its FTS dual-write in ONE batch so they move
			// all-or-none (ADR 0080 lockstep): a crash between the two can never
			// desync `term_search` from `term_record`. This is the single convergent
			// point every term write funnels through, so this keeps `term_search`
			// current across add/edit/delete/vote with one wiring.
			// Both items are drizzle query builders, NOT `db.run(sql)`: a batch item
			// must `_prepare()` to a `D1PreparedQuery` with a bound `.stmt`, which a
			// parametrized `db.run(sql\`…\`)` (a `SQLiteRaw`) lacks — it 500s the whole
			// batch on real D1 (#863). The builder prepares batch-safe.
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

		// Refresh `sozluk_stats` totals; runs after every write that could affect them
		// (write owned by the source-mutation path, not the query-only stats feature — ADR 0117).
		const recomputeSozlukStats = Effect.fn("Sozluk.recomputeSozlukStats")(function* (now: Date) {
			const totalTermsRow = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.termRecord)
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			// Public counts are LIVE-only for the anonymous viewer — sourced from the
			// shared seam (#1359/#1407), not re-derived here. Definitions carry no draft
			// dimension, so `publicLiveWhere` (removed + sandbox) is the full rule.
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

		// The recomputable-cache refresh (ADR 0011) every definition remove/restore runs
		// after the substrate write — the term summary + sözlük stats, the `refresh` the
		// shared transition swallows uniformly (#2012). Sequenced summary-then-stats, as
		// each arm did inline before the factoring.
		const refreshSozlukCaches = (slug: string, title: string, now: Date) =>
			Effect.gen(function* () {
				yield* persistTermSummary(slug, title, now);
				yield* recomputeSozlukStats(now);
			});

		// The backstop reconciliation sweep (#2558): re-run the convergent cache refresh for
		// EVERY term so a term/stat left stale by a swallowed last-write refresh
		// (`swallowRefresh`, #2012) is eventually re-converged without a next user write. Pages
		// `term_record` in slug-keyset chunks (bounded scan, mirrors #2559) refreshing each term
		// summary + its FTS row, then refreshes `sozluk_stats` once for the whole pass. Driven by
		// the cron trigger (`index.ts` → `sozluk-reconcile-cron.ts`). Idempotent by construction —
		// `persistTermSummary` is a pure convergent fold, so an already-fresh term rewrites the
		// identical row, meaning a full sweep needs no persisted "refresh failed" flag to target.
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
			// One stats refresh for the whole pass — `sozluk_stats` totals are table-wide, not
			// per-term, so re-deriving them once after the term sweep is sufficient and cheapest.
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

			// `sandboxed` is the owner-scoped in-review flag (#2200): computed off the fetched
			// record against the viewer, so a çaylak sees the "incelemede" signal on their OWN
			// still-in-review definition and no other viewer ever receives it.
			const page = forwardPage(
				fetched,
				first,
				(r: DefinitionRow) => r.id,
				(d) => ({
					...toDefinitionRow(d),
					sandboxed: ownSandboxed(d, viewerId),
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
						),
					),
			);
			const base = fetched.map((d) => ({
				...toDefinitionRow(d),
				sandboxed: ownSandboxed(d, viewerId),
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

		const getLandingTerms = Effect.fn("Sozluk.getLandingTerms")(function* (limit: number) {
			const n = Math.max(1, Math.min(limit, 50));
			// Rank terms by their most recent LIVE definition. The mask lives on the
			// `definition_record` arm (`removed_at IS NULL AND sandboxed_at IS NULL`),
			// mirroring `landingStats` (#1391): a term with only sandboxed definitions
			// contributes no row here, so its `term_record` summary (which can persist
			// with a zero live count) never reaches the public front door (#1205, #1424).
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

			// The definition row committed above; its convergent cache refreshes are
			// recomputable, so swallow-and-log a die here rather than 500 the mutation and
			// provoke a retry that mints a duplicate row (#2556, the create-path twin of #2012).
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

				// `outcome.sandboxedAt` is the round-tripped marker (#1811) — report's live
				// re-append gates the term-connection broadcast (a sandboxed restore stays
				// suppressed).
				return {restored: true, sandboxedAt: outcome.sandboxedAt};
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

			// Self-vote guard (#2216, founder-ruled): a cast on one's OWN definition is
			// rejected at the domain, so an inflated self-score is unrepresentable rather
			// than caught downstream. Cast-only (mirrors the `VoterNotEligible` tier gate) —
			// a retraction is exempt because a blocked cast leaves nothing to retract.
			if (isVote && definition.authorId === input.voterId) {
				return yield* new SelfVoteNotAllowed({
					voterId: input.voterId,
					message: "kendi tanımına oy veremezsin",
				});
			}

			// A Vote miss (raced soft-delete or sandboxed) collapses to this
			// surface's DefinitionNotFound — see translateVoteMiss.
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
				// Vote already wrote definition_record.score in its batch; this re-reads
				// it to refresh the term aggregates.
				yield* persistTermSummary(definition.termSlug, definition.termTitle, now);
			}

			return {
				definitionId: input.definitionId,
				score: voteResult.score,
				body: definition.body,
				authorId: definition.authorId,
				authorName: definition.authorName,
				createdAt: definition.createdAt ?? now,
				// A vote is not a content edit, so report the definition's genuine
				// `updatedAt` — never the vote instant, which would trip the
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
			// `VoterNotEligible` + `SelfVoteNotAllowed` both fire on the cast direction only
			// (`isVote`/`value: true`), so a retraction never raises either — die if one
			// somehow does, keeping this method's channel to `DefinitionNotFound`.
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
			// Load the target up-front so a missing/removed definition is this surface's
			// DefinitionNotFound. No sandbox filter — reactions are ungated, so a live
			// target is reactable regardless of the reactor's tier.
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

			// Delegate to the ungated, karma-free Reaction engine — no tier gate, no karma
			// write on this path (the settled #1861 divergence from Vote). A raced
			// target-miss collapses to this surface's DefinitionNotFound.
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

			// Re-resolve with the FRESH reaction aggregate + the reactor's own reaction,
			// through the same batched stamps every definition read shares (`myVote` via
			// stampViewerScalars, `reactions` via stampReactionAggregate, live identity via
			// stampAuthorIdentity) — so the wire row is shape-identical to a plain read.
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
