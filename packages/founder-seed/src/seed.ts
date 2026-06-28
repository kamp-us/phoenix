/**
 * The pure core of the founder-seed CLI (ADR 0107): mint the founding author-mod
 * cohort (#1207) — a named, editable roster ({@link FOUNDER_COHORT}) — as BOTH
 * `moderator` and `yazar`:
 *   - `moderator`: the legacy `user.role` column (ADR 0098) AND the `(id, "moderates",
 *     key(platform))` relation tuple on the `Relation` axis (ADR 0107) — both the
 *     coarse role read and the capability discharge a founder needs to moderate;
 *   - `yazar`: the server-managed authorship tier `user.tier` (#1203), the top of the
 *     `çaylak < yazar` stored ladder.
 *
 * This is the offline tuple/promotion path, NOT a runtime worker route (the deleted
 * `/api/admin/*` fail-open shape, CLAUDE.md "Sözlük seed").
 *
 * Idempotent + non-downgrading: the promotion `UPDATE` is guarded to skip a row already
 * at `(moderator, yazar)`, so a re-run reports `promoted: 0`; and because both targets
 * are the TOP of their enums, the write can never flip a manually-elevated founder back
 * down. The tuple `INSERT` is `onConflictDoNothing` against the composite PK, so a re-run
 * mints nothing new and never duplicates a grant. An id with no `user` row is skipped —
 * never a phantom promotion or an orphan tuple.
 *
 * The `object` key is `@kampus/authz`'s canonical `key(platform)` — the SAME encoding
 * the worker's `RelationStoreLive` reads with, so a discharge of `Moderate.over(platform)`
 * finds these seeded tuples (the write→read seam, ADR 0107). Never a bare `"platform"`
 * literal: that would not match the `type:id` read key, leaving the seeded founder denied.
 */
import {key, platform} from "@kampus/authz";
import {and, eq, inArray, ne, or, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {FOUNDER_COHORT} from "./cohort.ts";
import {seedSchema as schema} from "./schema.ts";

export const MODERATES = "moderates";
export const PLATFORM = key(platform);
// The founding cohort's target ranks — the top of each ladder, so a promotion to them
// is monotonic-up (never a downgrade). Hardcoded so an invalid founder grant is
// unrepresentable.
export const FOUNDER_ROLE = "moderator" as const;
export const FOUNDER_TIER = "yazar" as const;

export interface SeedResult {
	/** Size of the configured founder roster ({@link FOUNDER_COHORT}). */
	cohort: number;
	/** Roster members found as existing `user` rows (an unknown id is skipped). */
	matched: number;
	/** Rows promoted to `(moderator, yazar)` — `0` on a re-run (idempotent). */
	promoted: number;
	/** `moderates` tuples newly minted — `0` on a re-run or an empty cohort. */
	inserted: number;
}

export interface FounderTuple {
	readonly subject: string;
	readonly relation: string;
	readonly object: string;
}

export type SeedDb = ReturnType<typeof drizzle<typeof schema>>;

export const makeSeedDb = (d1: D1Database): SeedDb => drizzle(d1, {schema});

const EMPTY: SeedResult = {cohort: 0, matched: 0, promoted: 0, inserted: 0};

/**
 * Mint the founder roster as both `moderator` (role + `(id, "moderates", key(platform))`
 * tuple) and `yazar` (the `user.tier`). Returns `{cohort, matched, promoted, inserted}`
 * so the caller reports the cases distinctly — an empty roster, a first seed, and an
 * idempotent re-run (`promoted: 0, inserted: 0`) all read apart.
 *
 * `cohort` defaults to the configured {@link FOUNDER_COHORT}; tests pass an explicit
 * roster.
 */
export const seedFounders = async (
	db: SeedDb,
	cohort: ReadonlyArray<string> = FOUNDER_COHORT,
): Promise<SeedResult> => {
	if (cohort.length === 0) return EMPTY;
	const ids = [...cohort];
	const founders = await db
		.select({id: schema.user.id})
		.from(schema.user)
		.where(inArray(schema.user.id, ids))
		.all();
	if (founders.length === 0) return {...EMPTY, cohort: cohort.length};
	const matchedIds = founders.map((f) => f.id);
	const promote = await db
		.update(schema.user)
		.set({role: FOUNDER_ROLE, tier: FOUNDER_TIER})
		.where(
			and(
				inArray(schema.user.id, matchedIds),
				or(ne(schema.user.role, FOUNDER_ROLE), ne(schema.user.tier, FOUNDER_TIER)),
			),
		)
		.run();
	const minted = await db
		.insert(schema.relationTuple)
		.values(matchedIds.map((id) => ({subject: id, relation: MODERATES, object: PLATFORM})))
		.onConflictDoNothing()
		.run();
	return {
		cohort: cohort.length,
		matched: founders.length,
		promoted: promote.meta.changes,
		inserted: minted.meta.changes,
	};
};

/** List the founder tuples `(subject, "moderates", key(platform))` — the audit read the CLI prints. */
export const listFounderTuples = async (db: SeedDb): Promise<ReadonlyArray<FounderTuple>> => {
	const rows = await db
		.select({
			subject: schema.relationTuple.subject,
			relation: schema.relationTuple.relation,
			object: schema.relationTuple.object,
		})
		.from(schema.relationTuple)
		.where(
			and(eq(schema.relationTuple.relation, MODERATES), eq(schema.relationTuple.object, PLATFORM)),
		)
		.orderBy(sql`${schema.relationTuple.subject} ASC`)
		.all();
	return rows;
};
