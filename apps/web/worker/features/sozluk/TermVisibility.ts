/**
 * The sözlük term-list read mask: a `term_record` row is visible to a viewer only when
 * at least one of its definitions is (#3724).
 *
 * `term_record` is a recomputable summary cache, not content — it carries no lifecycle
 * columns of its own, so it cannot be masked directly. Visibility is therefore *derived*
 * from the definitions the row summarizes, which is where the çaylak sandbox (#1205) and
 * the ADR 0096 removal guard actually live. `Sozluk.getLandingTerms` derives the same fact
 * by ranking on live definitions; this is the reusable, viewer-aware form the paginated
 * term lists apply.
 */
import {and, eq, exists, type SQL, sql} from "drizzle-orm";
import type {DrizzleDb} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {publicLiveWhere} from "../lifecycle/SandboxVisibility.ts";

/**
 * `EXISTS (SELECT 1 FROM definition_record WHERE term_slug = term_record.slug AND
 * <publicLiveWhere>)` — the correlated existence probe that gates a `term_record` row on
 * the viewer's own definition visibility, sourced from the shared `publicLiveWhere` seam
 * (#1359/#1407) rather than a re-derived mask.
 *
 * Viewer-aware by construction, which is the load-bearing property: an anonymous visitor
 * never reaches a term whose only definitions are a newcomer's sandboxed ones (both a
 * dead-end public page and a partial sandbox-containment leak — the term title escapes),
 * while the author still finds their own not-yet-public term, and a moderator sees the
 * full backlog.
 */
export const termHasVisibleDefinitionWhere = (db: DrizzleDb, viewer: SandboxViewer): SQL =>
	exists(
		db
			.select({one: sql`1`})
			.from(schema.definitionRecord)
			.where(
				and(
					eq(schema.definitionRecord.termSlug, schema.termRecord.slug),
					publicLiveWhere(
						{
							removedAt: schema.definitionRecord.removedAt,
							sandboxedAt: schema.definitionRecord.sandboxedAt,
							authorId: schema.definitionRecord.authorId,
						},
						viewer,
					),
				),
			),
	);
