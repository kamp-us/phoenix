/**
 * The sözlük term-list read mask: a `term_record` row is visible to a viewer only when
 * at least one of its definitions is (#3724).
 *
 * `term_record` is a recomputable summary cache with no lifecycle columns of its own, so
 * it cannot be masked directly. Visibility is derived from the definitions it summarizes,
 * which is where the çaylak sandbox and the ADR 0096 removal guard actually live.
 */
import {and, eq, exists, type SQL, sql} from "drizzle-orm";
import type {DrizzleDb} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {publicLiveWhere} from "../lifecycle/SandboxVisibility.ts";

/**
 * Sourced from the shared `publicLiveWhere` seam rather than a re-derived mask, and
 * viewer-aware by construction — that is the load-bearing property. An anonymous visitor
 * must never reach a term whose only definitions are a newcomer's sandboxed ones (a
 * dead-end page AND a sandbox leak: the term title escapes), while the author still finds
 * their own not-yet-public term and a moderator sees the full backlog.
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
