/**
 * Sozluk — D1-direct module (task_5, d1-direct).
 *
 * Every function in this file reads/writes `env.PHOENIX_DB` via drizzle. There
 * is no Durable Object boundary, no workflow `create`, no outbox / projection
 * step. The legacy `SozlukTerm` Agent DO class still exists for one structural
 * task more (task_6 deletes it) but is unreferenced by every production code
 * path that lives here.
 *
 * Surface (resolver-callable):
 *   - `addDefinition(env, input)` — create term row (if missing) + insert
 *     `definition_view` row + recompute `term_summary` aggregates + bump
 *     `sozluk_stats`.
 *   - `voteDefinition(env, input)` / `retractDefinitionVote(env, input)` —
 *     mutate `definition_vote`, recompute `definition_view.score`, update
 *     `term_summary` aggregates, mirror onto `user_vote`, bump karma on
 *     `user_profile`. Idempotent: a duplicate cast or retract is a no-op.
 *   - `editDefinition(env, input)` — refresh `definition_view.body` +
 *     `body_excerpt` + `updated_at`. Ownership-checked.
 *   - `deleteDefinition(env, input)` — soft-delete `definition_view.deleted_at`,
 *     recompute term aggregates + stats. Ownership-checked.
 *
 * Read helpers (resolver-callable, replace `stub.getTerm()` /
 * `stub.listDefinitionsConnection(...)`):
 *   - `getTerm(env, slug)` — full term page (meta + ordered definitions).
 *   - `listDefinitionsConnection(env, slug, opts)` — keyset-paginated
 *     definitions for the term.
 *
 * Admin / seed surface (used by dev importer in `worker/index.ts`):
 *   - `seedTerm(env, input)` — idempotent upsert: create term if missing,
 *     insert any new definitions, leave duplicates alone.
 *   - `clearAllTerms(env, slugs)` — wipe definitions, votes, and term_summary
 *     rows for the given slugs; clears `sozluk_stats` too.
 *
 * Errors thrown by this module flow through the GraphQL `resolver()` wrapper
 * (see `worker/graphql/resolver.ts`) which routes them through
 * `encodeMutationError` for the wire-format `extensions.code`.
 */
import {id} from "@usirin/forge";
import {and, asc, desc, eq, isNull, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "../../db/drizzle/schema";
import {vote, VoteTargetNotFoundError} from "../vote/module";

/* -------------------------------------------------------------------------- */
/* Domain types + errors                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Body length cap — surfaced as `body_too_long` to the resolver. Mirrors the
 * pre-d1-direct DO contract.
 */
export const DEFINITION_BODY_MAX = 10_000;

const EXCERPT_LEN = 140;

function excerpt(body: string): string {
	const flat = body.replace(/\s+/g, " ").trim();
	if (flat.length <= EXCERPT_LEN) return flat;
	return `${flat.slice(0, EXCERPT_LEN - 1).trimEnd()}…`;
}

/**
 * Validation error raised by `addDefinition` / `editDefinition`. The GraphQL
 * resolver catches it via `encodeMutationError` and surfaces a typed
 * `extensions.code`.
 */
export class DefinitionValidationError extends Error {
	constructor(
		readonly code: "body_required" | "body_too_long",
		message: string,
	) {
		super(message);
		this.name = "DefinitionValidationError";
	}
}

/**
 * Raised by every mutation that targets a `definition_view` row that doesn't
 * exist (or has been soft-deleted in cases where existence is required).
 */
export class DefinitionNotFoundError extends Error {
	readonly code = "definition_not_found" as const;
	constructor(definitionId: string) {
		super(`definition ${definitionId} not found`);
		this.name = "DefinitionNotFoundError";
	}
}

/**
 * Raised by `editDefinition` / `deleteDefinition` when the calling user is
 * not the row's author. The resolver translates this to a clean
 * `UNAUTHORIZED` extension code.
 */
export class UnauthorizedDefinitionMutationError extends Error {
	readonly code = "unauthorized" as const;
	constructor(definitionId: string) {
		super(`not authorized to mutate definition ${definitionId}`);
		this.name = "UnauthorizedDefinitionMutationError";
	}
}

/* -------------------------------------------------------------------------- */
/* Read shapes (mirror SozlukTerm types pre-d1-direct)                          */
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

/* -------------------------------------------------------------------------- */
/* Mutation result shapes                                                      */
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

export interface SeedDefinitionInput {
	authorId: string;
	authorName: string;
	body: string;
	score?: number | undefined;
}

export interface SeedTermInput {
	slug: string;
	title: string;
	definitions: SeedDefinitionInput[];
}

export interface SeedTermResult {
	created: boolean;
	insertedDefinitions: number;
	skippedDefinitions: number;
}

export interface ClearAllTermsResult {
	terms: number;
	definitions: number;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Full term page read: meta from `term_summary` + ordered non-deleted
 * definitions from `definition_view`. Returns `null` when no term row exists
 * for the slug (treated identically to "term doesn't exist" — the SPA renders
 * the empty-term affordance to encourage the first definition).
 */
export async function getTerm(env: Env, slug: string): Promise<TermPage | null> {
	const db = drizzle(env.PHOENIX_DB, {schema});

	const meta = await db.query.termSummary.findFirst({
		where: eq(schema.termSummary.slug, slug),
	});
	if (!meta) return null;

	const defs = await db
		.select()
		.from(schema.definitionView)
		.where(and(eq(schema.definitionView.termSlug, slug), isNull(schema.definitionView.deletedAt)))
		.orderBy(desc(schema.definitionView.score), asc(schema.definitionView.createdAt));

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
	};
}

/**
 * Connection-shaped read for `Term.definitions(first, after)`. Materializes
 * the same ordered list as `getTerm` then slices by cursor. Stable across
 * the d1-direct migration: the resolver-side contract is identical to what
 * `SozlukTerm.listDefinitionsConnection` returned.
 */
export async function listDefinitionsConnection(
	env: Env,
	slug: string,
	opts: {first?: number | undefined; after?: string | null | undefined} = {},
): Promise<DefinitionConnectionPage> {
	const page = await getTerm(env, slug);
	if (!page) {
		return {rows: [], hasNextPage: false, endCursor: null, totalCount: 0};
	}
	const sorted = page.definitions;
	const first = Math.max(1, Math.min(opts.first ?? 50, 200));
	const after = opts.after ?? null;
	const startIndex = after ? sorted.findIndex((d) => d.id === after) + 1 : 0;
	const safeStart = startIndex < 0 ? 0 : startIndex;
	const sliced = sorted.slice(safeStart, safeStart + first);
	const hasNextPage = safeStart + first < sorted.length;
	const last = sliced.at(-1) ?? null;
	return {
		rows: sliced,
		hasNextPage,
		endCursor: last ? last.id : null,
		totalCount: sorted.length,
	};
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Insert a new definition under `termSlug`. Auto-creates the term row when
 * the slug doesn't exist yet (the SPA's "submit on an unknown slug" flow).
 *
 * Validation:
 * - `body` must be non-empty after trimming
 * - `body.length` ≤ {@link DEFINITION_BODY_MAX}
 *
 * Writes (in dependency order):
 *   1. Insert `definition_view` row (full body + excerpt + author).
 *   2. Upsert `term_summary` with recomputed aggregates.
 *   3. Bump `sozluk_stats` totals.
 */
export async function addDefinition(
	env: Env,
	input: AddDefinitionInput,
): Promise<AddDefinitionResult> {
	const rawBody = input.body ?? "";
	if (rawBody.trim().length === 0) {
		throw new DefinitionValidationError("body_required", "tanım boş olamaz");
	}
	if (rawBody.length > DEFINITION_BODY_MAX) {
		throw new DefinitionValidationError(
			"body_too_long",
			`tanım en fazla ${DEFINITION_BODY_MAX} karakter olabilir`,
		);
	}

	const db = drizzle(env.PHOENIX_DB, {schema});
	const slug = input.termSlug;
	const existing = await db.query.termSummary.findFirst({
		where: eq(schema.termSummary.slug, slug),
	});
	const termCreated = !existing;
	const title = existing?.title ?? input.termTitle ?? slug.replace(/-/g, " ");

	const definitionId = id("def");
	const now = new Date();
	const bodyExcerpt = excerpt(rawBody);

	await db.insert(schema.definitionView).values({
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
	});

	await recomputeTermSummary(env, slug, title, now);
	await recomputeSozlukStats(env, now);

	return {
		definitionId,
		termCreated,
		score: 0,
		body: rawBody,
		authorId: input.authorId,
		authorName: input.authorName,
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Cast an up-vote on a definition. Delegates to the shared vote module
 * (task_10) — idempotency, `user_vote` mirror writes, and the atomic
 * batch live there. After the vote module returns, this wrapper recomputes
 * the `term_summary` aggregates so the term page's score/last-edit
 * denormalizations stay convergent.
 */
export async function voteDefinition(
	env: Env,
	input: VoteDefinitionInput,
): Promise<VoteDefinitionResult> {
	return applyVote(env, input, true);
}

/**
 * Retract a previously-cast vote. Delegates to the shared vote module.
 * Idempotent: retracting when no row exists is a no-op.
 */
export async function retractDefinitionVote(
	env: Env,
	input: VoteDefinitionInput,
): Promise<VoteDefinitionResult> {
	return applyVote(env, input, false);
}

async function applyVote(
	env: Env,
	input: VoteDefinitionInput,
	isVote: boolean,
): Promise<VoteDefinitionResult> {
	// Load definition meta up-front so we can return the canonical resolver
	// shape (body / author / timestamps) regardless of changed/no-op path.
	const db = drizzle(env.PHOENIX_DB, {schema});
	const definition = await db.query.definitionView.findFirst({
		where: and(
			eq(schema.definitionView.id, input.definitionId),
			isNull(schema.definitionView.deletedAt),
		),
	});
	if (!definition) {
		throw new DefinitionNotFoundError(input.definitionId);
	}

	let voteResult;
	try {
		voteResult = await vote(env, {
			userId: input.voterId,
			targetKind: "definition",
			targetId: input.definitionId,
			value: isVote ? 1 : null,
		});
	} catch (err) {
		// Race: the definition was soft-deleted between our read and the
		// vote module's own existence check. Surface the sozluk-typed error
		// so the resolver codec keeps producing `DEFINITION_NOT_FOUND`.
		if (err instanceof VoteTargetNotFoundError) {
			throw new DefinitionNotFoundError(input.definitionId);
		}
		throw err;
	}

	const now = new Date();
	if (voteResult.changed) {
		// Refresh term_summary aggregates against the new score slice. The
		// vote module already wrote definition_view.score inside its batch;
		// recomputeTermSummary re-reads that and the rest of the slice.
		await recomputeTermSummary(env, definition.termSlug, definition.termTitle, now);
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
	};
}

/**
 * Edit the body of an existing definition. Ownership-checked: the calling
 * user must be the definition's `authorId`. Updates `body`, `body_excerpt`,
 * and `updated_at`; the score is unchanged. `term_summary.last_edit_at`
 * advances so feed orderings refresh.
 */
export async function editDefinition(
	env: Env,
	input: EditDefinitionInput,
): Promise<EditDefinitionResult> {
	const rawBody = input.body ?? "";
	if (rawBody.trim().length === 0) {
		throw new DefinitionValidationError("body_required", "tanım boş olamaz");
	}
	if (rawBody.length > DEFINITION_BODY_MAX) {
		throw new DefinitionValidationError(
			"body_too_long",
			`tanım en fazla ${DEFINITION_BODY_MAX} karakter olabilir`,
		);
	}

	const db = drizzle(env.PHOENIX_DB, {schema});
	const definition = await db.query.definitionView.findFirst({
		where: and(
			eq(schema.definitionView.id, input.definitionId),
			isNull(schema.definitionView.deletedAt),
		),
	});
	if (!definition) {
		throw new DefinitionNotFoundError(input.definitionId);
	}
	if (definition.authorId !== input.actorId) {
		throw new UnauthorizedDefinitionMutationError(input.definitionId);
	}

	const now = new Date();
	const bodyExcerpt = excerpt(rawBody);

	await db
		.update(schema.definitionView)
		.set({body: rawBody, bodyExcerpt, updatedAt: now})
		.where(eq(schema.definitionView.id, input.definitionId));

	await recomputeTermSummary(env, definition.termSlug, definition.termTitle, now);

	return {
		definitionId: input.definitionId,
		score: definition.score,
		body: rawBody,
		authorId: definition.authorId,
		authorName: definition.authorName,
		createdAt: definition.createdAt ?? now,
		updatedAt: now,
	};
}

/**
 * Soft-delete a definition (stamps `definition_view.deleted_at`). Reads
 * filter on `deleted_at IS NULL`. Term aggregates recompute against the
 * non-deleted slice. Idempotent: re-deleting a row that's already
 * soft-deleted returns `deleted: false` and changes nothing.
 */
export async function deleteDefinition(
	env: Env,
	input: DeleteDefinitionInput,
): Promise<DeleteDefinitionResult> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const definition = await db.query.definitionView.findFirst({
		where: eq(schema.definitionView.id, input.definitionId),
	});
	if (!definition) {
		throw new DefinitionNotFoundError(input.definitionId);
	}
	if (definition.authorId !== input.actorId) {
		throw new UnauthorizedDefinitionMutationError(input.definitionId);
	}
	if (definition.deletedAt) {
		return {definitionId: input.definitionId, deleted: false};
	}

	const now = new Date();
	await db
		.update(schema.definitionView)
		.set({deletedAt: now, updatedAt: now})
		.where(eq(schema.definitionView.id, input.definitionId));

	await recomputeTermSummary(env, definition.termSlug, definition.termTitle, now);
	await recomputeSozlukStats(env, now);

	return {definitionId: input.definitionId, deleted: true};
}

/* -------------------------------------------------------------------------- */
/* Admin / seed                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Idempotent term seed used by the dev importer. Creates `term_summary` if
 * missing; for each input definition, inserts unless `(authorId, body)`
 * collides with an existing row under this slug (legacy behavior preserved
 * so the importer skips identical re-runs).
 *
 * Skips dispatching projection events — under d1-direct the writes here are
 * the authoritative state.
 */
export async function seedTerm(env: Env, input: SeedTermInput): Promise<SeedTermResult> {
	if (input.definitions.length === 0) {
		throw new Error("seedTerm: at least one definition required");
	}

	const db = drizzle(env.PHOENIX_DB, {schema});
	const existing = await db.query.termSummary.findFirst({
		where: eq(schema.termSummary.slug, input.slug),
	});

	const now = new Date();
	let inserted = 0;
	let skipped = 0;

	for (const def of input.definitions) {
		// Idempotency: skip when (term_slug, author_id, body) already present.
		const dupe = await env.PHOENIX_DB.prepare(
			`SELECT id FROM definition_view
			 WHERE term_slug = ? AND author_id = ? AND body = ?
			 LIMIT 1`,
		)
			.bind(input.slug, def.authorId, def.body)
			.first<{id: string}>();
		if (dupe) {
			skipped++;
			continue;
		}

		await db.insert(schema.definitionView).values({
			id: id("def"),
			authorId: def.authorId,
			authorName: def.authorName,
			termSlug: input.slug,
			termTitle: input.title,
			body: def.body,
			bodyExcerpt: excerpt(def.body),
			score: def.score ?? 0,
			createdAt: now,
			updatedAt: now,
			deletedAt: null,
			lastEventId: "",
		});
		inserted++;
	}

	await recomputeTermSummary(env, input.slug, input.title, now);
	await recomputeSozlukStats(env, now);

	return {
		created: !existing,
		insertedDefinitions: inserted,
		skippedDefinitions: skipped,
	};
}

/**
 * Wipe definition rows + votes for every slug in the argument. Also clears
 * the matching `term_summary` rows and refreshes `sozluk_stats`. Used by
 * the dev importer's `--clear` flag.
 */
export async function clearAllTerms(env: Env, slugs: string[]): Promise<ClearAllTermsResult> {
	if (slugs.length === 0) {
		return {terms: 0, definitions: 0};
	}
	const placeholders = slugs.map(() => "?").join(",");

	// Count deletions before issuing them so the caller can show meaningful
	// progress. The DELETE statements return `meta.changes` too, but we want
	// to be honest about how many term rows existed (a slug with no row is
	// silently a no-op).
	const termCount = await env.PHOENIX_DB.prepare(
		`SELECT COUNT(*) as n FROM term_summary WHERE slug IN (${placeholders})`,
	)
		.bind(...slugs)
		.first<{n: number}>();
	const defCount = await env.PHOENIX_DB.prepare(
		`SELECT COUNT(*) as n FROM definition_view WHERE term_slug IN (${placeholders})`,
	)
		.bind(...slugs)
		.first<{n: number}>();

	// Drop vote rows for these definitions, then the definitions themselves,
	// then the term meta rows. Order matters for the `definition_vote`
	// composite-key cleanup.
	await env.PHOENIX_DB.prepare(
		`DELETE FROM definition_vote
		 WHERE definition_id IN (
			SELECT id FROM definition_view WHERE term_slug IN (${placeholders})
		)`,
	)
		.bind(...slugs)
		.run();
	await env.PHOENIX_DB.prepare(
		`DELETE FROM user_vote
		 WHERE target_kind = 'definition' AND target_id IN (
			SELECT id FROM definition_view WHERE term_slug IN (${placeholders})
		)`,
	)
		.bind(...slugs)
		.run();
	await env.PHOENIX_DB.prepare(`DELETE FROM definition_view WHERE term_slug IN (${placeholders})`)
		.bind(...slugs)
		.run();
	await env.PHOENIX_DB.prepare(`DELETE FROM term_summary WHERE slug IN (${placeholders})`)
		.bind(...slugs)
		.run();

	await recomputeSozlukStats(env, new Date());

	return {
		terms: termCount?.n ?? 0,
		definitions: defCount?.n ?? 0,
	};
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Recompute `term_summary` row for one slug from the live `definition_view`
 * slice (`WHERE term_slug = slug AND deleted_at IS NULL`). Convergent: the
 * row is fully derived from definitions + meta inputs (title); a no-op when
 * the slice is empty and the row already exists (idempotent re-run).
 */
async function recomputeTermSummary(
	env: Env,
	slug: string,
	title: string,
	now: Date,
): Promise<void> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const defs = await db
		.select({
			id: schema.definitionView.id,
			body: schema.definitionView.body,
			bodyExcerpt: schema.definitionView.bodyExcerpt,
			score: schema.definitionView.score,
			createdAt: schema.definitionView.createdAt,
			updatedAt: schema.definitionView.updatedAt,
		})
		.from(schema.definitionView)
		.where(and(eq(schema.definitionView.termSlug, slug), isNull(schema.definitionView.deletedAt)))
		.orderBy(desc(schema.definitionView.score), asc(schema.definitionView.createdAt));

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

	await env.PHOENIX_DB.prepare(
		`INSERT INTO term_summary (
			slug, title, first_letter, definition_count, total_score,
			excerpt, top_definition_id, first_at, last_activity_at,
			last_edit_at, last_event_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
		ON CONFLICT(slug) DO UPDATE SET
			title             = excluded.title,
			definition_count  = excluded.definition_count,
			total_score       = excluded.total_score,
			excerpt           = excluded.excerpt,
			top_definition_id = excluded.top_definition_id,
			first_at          = excluded.first_at,
			last_activity_at  = excluded.last_activity_at,
			last_edit_at      = excluded.last_edit_at`,
	)
		.bind(
			slug,
			title,
			firstLetter,
			defs.length,
			totalScore,
			topExcerpt,
			top?.id ?? null,
			firstAtSec,
			lastActivitySec,
			lastEditSec,
		)
		.run();
}

/**
 * Refresh `sozluk_stats` totals. Same shape as the legacy projection helper
 * — three small COUNT queries plus one upsert. Cheap; runs after every write
 * that could affect totals.
 */
async function recomputeSozlukStats(env: Env, now: Date): Promise<void> {
	const totalTerms = await env.PHOENIX_DB.prepare(`SELECT COUNT(*) as n FROM term_summary`).first<{
		n: number;
	}>();
	const totalDefs = await env.PHOENIX_DB.prepare(
		`SELECT COUNT(*) as n FROM definition_view WHERE deleted_at IS NULL`,
	).first<{n: number}>();
	const totalAuthors = await env.PHOENIX_DB.prepare(
		`SELECT COUNT(DISTINCT author_id) as n FROM definition_view WHERE deleted_at IS NULL`,
	).first<{n: number}>();

	const nowSec = Math.floor(now.getTime() / 1000);
	await env.PHOENIX_DB.prepare(
		`INSERT INTO sozluk_stats (id, total_definitions, total_terms, total_authors, updated_at)
		 VALUES (1, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
			total_definitions = excluded.total_definitions,
			total_terms       = excluded.total_terms,
			total_authors     = excluded.total_authors,
			updated_at        = excluded.updated_at`,
	)
		.bind(totalDefs?.n ?? 0, totalTerms?.n ?? 0, totalAuthors?.n ?? 0, nowSec)
		.run();
}

// Silence drizzle's "unused import" for `sql` — kept for parity with sibling
// modules + likely use when this module grows raw expressions.
void sql;
