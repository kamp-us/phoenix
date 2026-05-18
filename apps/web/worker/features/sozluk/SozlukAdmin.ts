/**
 * Sozluk admin service — operations the dev-only `/api/admin/sozluk/*` routes
 * call after `AdminAuth.required` succeeds.
 *
 *   - `seedTerm` — idempotent upsert used by the dev importer: create term row
 *     if missing, insert any new definitions, skip duplicates by
 *     `(term_slug, author_id, body)`. Also refreshes `term_summary` aggregates
 *     and `sozluk_stats` totals so the home page reflects the seed.
 *   - `clearAllTerms` — wipe `definition_view`, `definition_vote`, `user_vote`,
 *     and `term_summary` rows for the given slugs; refresh `sozluk_stats`.
 *
 * Lives in a separate service from `Sozluk` per ADR 0012: admin operations
 * shouldn't pollute the resolver context and are gated by `AdminAuth.required`
 * rather than `Auth.required`.
 */
import {id} from "@usirin/forge";
import {and, asc, desc, eq, isNull, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import * as schema from "../../db/drizzle/schema";
import {Drizzle, type DrizzleError} from "../../services/Drizzle";
import {excerpt as excerptText} from "../../shared/text";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const DEFINITION_EXCERPT_LEN = 140;

const excerpt = (body: string): string => excerptText(body, DEFINITION_EXCERPT_LEN);

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

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
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

export class SozlukAdmin extends Context.Service<
	SozlukAdmin,
	{
		readonly seedTerm: (input: SeedTermInput) => Effect.Effect<SeedTermResult, DrizzleError>;

		readonly clearAllTerms: (slugs: string[]) => Effect.Effect<ClearAllTermsResult, DrizzleError>;
	}
>()("@phoenix/sozluk/SozlukAdmin") {}

/* -------------------------------------------------------------------------- */
/* Live layer                                                                  */
/* -------------------------------------------------------------------------- */

export const SozlukAdminLive = Layer.effect(SozlukAdmin)(
	Effect.gen(function* () {
		// Per the post-fbb57d8 reshape: yield Drizzle once at layer build and
		// destructure its bound methods.
		const {run} = yield* Drizzle;

		/**
		 * Recompute the `term_summary` row for one slug from the live
		 * `definition_view` slice. Same shape as Sozluk's closure-private
		 * helper — duplicated here so SozlukAdmin's `R` channel stays
		 * `Drizzle` only (no cross-service dep).
		 */
		const recomputeTermSummary = Effect.fn("SozlukAdmin.recomputeTermSummary")(function* (
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

		const recomputeSozlukStats = Effect.fn("SozlukAdmin.recomputeSozlukStats")(function* (
			now: Date,
		) {
			const totalTerms = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.termSummary)
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			const totalDefs = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.definitionView)
					.where(isNull(schema.definitionView.deletedAt))
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			const totalAuthors = yield* run((db) =>
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
					VALUES (1, ${totalDefs}, ${totalTerms}, ${totalAuthors}, ${nowSec})
					ON CONFLICT(id) DO UPDATE SET
						total_definitions = excluded.total_definitions,
						total_terms       = excluded.total_terms,
						total_authors     = excluded.total_authors,
						updated_at        = excluded.updated_at
				`),
			);
		});

		return {
			seedTerm: Effect.fn("SozlukAdmin.seedTerm")(function* (input: SeedTermInput) {
				if (input.definitions.length === 0) {
					return yield* Effect.die(new Error("seedTerm: at least one definition required"));
				}

				const existing = yield* run((db) =>
					db.query.termSummary.findFirst({where: eq(schema.termSummary.slug, input.slug)}),
				);

				const now = new Date();
				let inserted = 0;
				let skipped = 0;

				for (const def of input.definitions) {
					// Idempotency: skip when (term_slug, author_id, body)
					// already present.
					const dupe = yield* run((db) =>
						db
							.select({id: schema.definitionView.id})
							.from(schema.definitionView)
							.where(
								and(
									eq(schema.definitionView.termSlug, input.slug),
									eq(schema.definitionView.authorId, def.authorId),
									eq(schema.definitionView.body, def.body),
								),
							)
							.limit(1)
							.get(),
					);
					if (dupe) {
						skipped++;
						continue;
					}

					yield* run((db) =>
						db.insert(schema.definitionView).values({
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
						}),
					);
					inserted++;
				}

				yield* recomputeTermSummary(input.slug, input.title, now);
				yield* recomputeSozlukStats(now);

				return {
					created: !existing,
					insertedDefinitions: inserted,
					skippedDefinitions: skipped,
				} satisfies SeedTermResult;
			}),

			clearAllTerms: Effect.fn("SozlukAdmin.clearAllTerms")(function* (slugs: string[]) {
				if (slugs.length === 0) {
					return {terms: 0, definitions: 0} satisfies ClearAllTermsResult;
				}

				// Count rows before deletion so the caller can show meaningful
				// progress.
				const termCount = yield* run((db) =>
					db
						.select({n: sql<number>`COUNT(*)`})
						.from(schema.termSummary)
						.where(sql`${schema.termSummary.slug} IN ${slugs}`)
						.then((r) => Number(r[0]?.n ?? 0)),
				);
				const defCount = yield* run((db) =>
					db
						.select({n: sql<number>`COUNT(*)`})
						.from(schema.definitionView)
						.where(sql`${schema.definitionView.termSlug} IN ${slugs}`)
						.then((r) => Number(r[0]?.n ?? 0)),
				);

				// Drop vote rows for these definitions, then the definitions
				// themselves, then the term meta rows. Order matters for the
				// `definition_vote` composite-key cleanup.
				yield* run((db) =>
					db.run(sql`
						DELETE FROM definition_vote
						WHERE definition_id IN (
							SELECT id FROM definition_view WHERE term_slug IN ${slugs}
						)
					`),
				);
				yield* run((db) =>
					db.run(sql`
						DELETE FROM user_vote
						WHERE target_kind = 'definition' AND target_id IN (
							SELECT id FROM definition_view WHERE term_slug IN ${slugs}
						)
					`),
				);
				yield* run((db) => db.run(sql`DELETE FROM definition_view WHERE term_slug IN ${slugs}`));
				yield* run((db) => db.run(sql`DELETE FROM term_summary WHERE slug IN ${slugs}`));

				yield* recomputeSozlukStats(new Date());

				return {terms: termCount, definitions: defCount} satisfies ClearAllTermsResult;
			}),
		};
	}),
);
