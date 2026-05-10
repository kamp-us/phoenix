/**
 * Phoenix view-layer projection workflow.
 *
 * Single workflow class that consumes events emitted by per-entity Agents
 * (`SozlukTerm`, `PanoPost`) via the outbox + `flushOutbox` dispatcher and
 * convergent-overwrites the corresponding rows in `PHOENIX_DB`.
 *
 * Lineage: ADR 0007 (view layer — outbox + Workflows + single D1).
 *
 * The `run` method dispatches on `event.kind`. Each kind owns one
 * `step.do(...)` block; the body of each block is currently a no-op so the
 * binding compiles and downstream tasks (T2..T15) can fill in real
 * projection writes one event kind at a time.
 *
 * Conventions for the projection bodies (locked in by ADR 0007 — implementers
 * do not need to redecide these):
 *
 * - Each body is one D1 write to one MV table. No cross-table joins.
 * - Convergent overwrite guarded by `WHERE last_event_id < excluded.last_event_id`
 *   (forge ULID lex ordering). Out-of-order retries become no-ops.
 * - Errors throw so the workflow runtime retries the step with backoff.
 */
import {WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep} from "cloudflare:workers";
import {sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "./drizzle/schema";

/* -------------------------------------------------------------------------- */
/* Event payloads                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Common envelope fields on every projection event. `eventId` is a forge ULID
 * that doubles as the workflow instance id (idempotent on retry) and the
 * convergence guard column on the target MV row.
 */
interface ProjectionEventBase {
	eventId: string;
}

export interface TermChangedEvent extends ProjectionEventBase {
	kind: "TermChanged";
	slug: string;
	title: string;
	definitionCount: number;
	totalScore: number;
	topDefinitionId: string | null;
	excerpt: string | null;
	firstAt: number;
	lastActivityAt: number;
	lastEditAt: number;
}

export interface DefinitionAddedEvent extends ProjectionEventBase {
	kind: "DefinitionAdded";
	definitionId: string;
	authorId: string;
	authorName: string;
	termSlug: string;
	termTitle: string;
	bodyExcerpt: string;
	score: number;
	createdAt: number;
}

export interface DefinitionEditedEvent extends ProjectionEventBase {
	kind: "DefinitionEdited";
	definitionId: string;
	bodyExcerpt: string;
	updatedAt: number;
}

export interface DefinitionDeletedEvent extends ProjectionEventBase {
	kind: "DefinitionDeleted";
	definitionId: string;
	deletedAt: number;
}

export interface PostChangedEvent extends ProjectionEventBase {
	kind: "PostChanged";
	postId: string;
	slug: string | null;
	title: string;
	host: string | null;
	bodyExcerpt: string | null;
	authorId: string;
	authorName: string;
	tags: string[];
	score: number;
	commentCount: number;
	hotScore: number;
	createdAt: number;
	updatedAt: number;
	lastActivityAt: number;
}

export interface PostDeletedEvent extends ProjectionEventBase {
	kind: "PostDeleted";
	postId: string;
	deletedAt: number;
}

export interface CommentAddedEvent extends ProjectionEventBase {
	kind: "CommentAdded";
	commentId: string;
	authorId: string;
	authorName: string;
	postId: string;
	postTitle: string;
	bodyExcerpt: string;
	score: number;
	createdAt: number;
}

export interface CommentChangedEvent extends ProjectionEventBase {
	kind: "CommentChanged";
	commentId: string;
	score: number;
	updatedAt: number;
}

export interface CommentEditedEvent extends ProjectionEventBase {
	kind: "CommentEdited";
	commentId: string;
	bodyExcerpt: string;
	updatedAt: number;
}

export interface CommentDeletedEvent extends ProjectionEventBase {
	kind: "CommentDeleted";
	commentId: string;
	hasReplies: boolean;
	deletedAt: number;
}

export interface VoteRecordedEvent extends ProjectionEventBase {
	kind: "VoteRecorded";
	userId: string;
	targetKind: "definition" | "post" | "comment";
	targetId: string;
	// Producer's authoritative author for karma adjustment.
	targetAuthorId: string;
	// `true` = vote was cast, `false` = vote was retracted.
	value: boolean;
	createdAt: number;
}

export interface SozlukStatsChangedEvent extends ProjectionEventBase {
	kind: "SozlukStatsChanged";
	deltaTerms: number;
	deltaDefinitions: number;
	deltaAuthors: number;
	updatedAt: number;
}

export interface PanoStatsChangedEvent extends ProjectionEventBase {
	kind: "PanoStatsChanged";
	deltaPosts: number;
	deltaComments: number;
	deltaAuthors: number;
	updatedAt: number;
}

export interface UserProfileChangedEvent extends ProjectionEventBase {
	kind: "UserProfileChanged";
	userId: string;
	username: string;
	displayName: string | null;
	image: string | null;
	updatedAt: number;
}

export type ProjectionEvent =
	| TermChangedEvent
	| DefinitionAddedEvent
	| DefinitionEditedEvent
	| DefinitionDeletedEvent
	| PostChangedEvent
	| PostDeletedEvent
	| CommentAddedEvent
	| CommentChangedEvent
	| CommentEditedEvent
	| CommentDeletedEvent
	| VoteRecordedEvent
	| SozlukStatsChangedEvent
	| PanoStatsChangedEvent
	| UserProfileChangedEvent;

/* -------------------------------------------------------------------------- */
/* Projection step bodies                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `TermChanged` projects per-term aggregates into `term_summary`. Convergent
 * overwrite guarded by `WHERE last_event_id < excluded.last_event_id` (forge
 * ULID lex ordering — out-of-order retries become no-ops).
 *
 * `sozluk_stats` totals are touched as part of the same step: we delta the
 * `total_terms` row only on first-time inserts (existing slug → no-op on the
 * delta). `total_definitions` is recomputed from the event payload's
 * authoritative count for this term, so we apply the delta against the
 * previous row's `definition_count`. `total_authors` waits for T4
 * (`DefinitionAdded` knows authors); seed runs through here without bumping
 * authors since the seed author (`kampus`) is denormalized everywhere.
 */
async function projectTermChanged(env: Env, e: TermChangedEvent): Promise<void> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const firstLetter = e.slug.charAt(0).toLowerCase();

	const previous = await db
		.select({
			definitionCount: schema.termSummary.definitionCount,
			lastEventId: schema.termSummary.lastEventId,
		})
		.from(schema.termSummary)
		.where(sql`${schema.termSummary.slug} = ${e.slug}`)
		.limit(1);
	const previousRow = previous[0];

	const result = await env.PHOENIX_DB.prepare(
		`INSERT INTO term_summary (
			slug, title, first_letter, definition_count, total_score,
			excerpt, top_definition_id, first_at, last_activity_at,
			last_edit_at, last_event_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(slug) DO UPDATE SET
			title             = excluded.title,
			definition_count  = excluded.definition_count,
			total_score       = excluded.total_score,
			excerpt           = excluded.excerpt,
			top_definition_id = excluded.top_definition_id,
			first_at          = excluded.first_at,
			last_activity_at  = excluded.last_activity_at,
			last_edit_at      = excluded.last_edit_at,
			last_event_id     = excluded.last_event_id
		WHERE term_summary.last_event_id < excluded.last_event_id`,
	)
		.bind(
			e.slug,
			e.title,
			firstLetter,
			e.definitionCount,
			e.totalScore,
			e.excerpt,
			e.topDefinitionId,
			e.firstAt > 0 ? Math.floor(e.firstAt / 1000) : null,
			Math.floor(e.lastActivityAt / 1000),
			e.lastEditAt > 0 ? Math.floor(e.lastEditAt / 1000) : null,
			e.eventId,
		)
		.run();

	// If the guard rejected the upsert (out-of-order retry), bail — no
	// stats delta either.
	if (result.meta.changes === 0) return;

	const isNewTerm = !previousRow;
	const previousDefinitionCount = previousRow?.definitionCount ?? 0;
	const definitionDelta = e.definitionCount - previousDefinitionCount;
	const termDelta = isNewTerm ? 1 : 0;

	if (termDelta === 0 && definitionDelta === 0) return;

	const updatedAt = Math.floor(e.lastActivityAt / 1000);
	await env.PHOENIX_DB.prepare(
		`INSERT INTO sozluk_stats (id, total_definitions, total_terms, total_authors, updated_at)
		VALUES (1, ?, ?, 0, ?)
		ON CONFLICT(id) DO UPDATE SET
			total_definitions = sozluk_stats.total_definitions + ?,
			total_terms       = sozluk_stats.total_terms + ?,
			updated_at        = ?`,
	)
		.bind(Math.max(0, definitionDelta), termDelta, updatedAt, definitionDelta, termDelta, updatedAt)
		.run();
}

/* -------------------------------------------------------------------------- */
/* Workflow                                                                   */
/* -------------------------------------------------------------------------- */

export class PhoenixProjection extends WorkflowEntrypoint<Env, ProjectionEvent> {
	override async run(event: Readonly<WorkflowEvent<ProjectionEvent>>, step: WorkflowStep) {
		const e = event.payload;

		await step.do(`project-${e.kind}`, async () => {
			switch (e.kind) {
				// Sozluk
				case "TermChanged":
					return projectTermChanged(this.env, e);
				case "DefinitionAdded":
					return;
				case "DefinitionEdited":
					return;
				case "DefinitionDeleted":
					return;

				// Pano
				case "PostChanged":
					return;
				case "PostDeleted":
					return;
				case "CommentAdded":
					return;
				case "CommentChanged":
					return;
				case "CommentEdited":
					return;
				case "CommentDeleted":
					return;

				// Cross-product
				case "VoteRecorded":
					return;
				case "SozlukStatsChanged":
					return;
				case "PanoStatsChanged":
					return;
				case "UserProfileChanged":
					return;

				default: {
					// Exhaustiveness guard: TS will error here if a new event
					// kind is added to ProjectionEvent without a case above.
					const _exhaustive: never = e;
					throw new Error(`unknown projection event kind: ${JSON.stringify(_exhaustive)}`);
				}
			}
		});
	}
}
