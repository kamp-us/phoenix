/**
 * The pure core of the founder-seed CLI (ADR 0107): mint the founder cohort
 * (`role='moderator'` users, ADR 0098's offline grant cohort) as
 * `(id, "moderates", key(platform))` relation tuples — the day-one moderation
 * authority on the `Relation` axis. This is the offline tuple-assignment path,
 * NOT a runtime worker route (the deleted `/api/admin/*` fail-open shape,
 * CLAUDE.md "Sözlük seed"). Idempotent: `onConflictDoNothing` against the
 * composite PK, so a re-run mints nothing new and never duplicates a grant.
 *
 * The `object` key is `@kampus/authz`'s canonical `key(platform)` — the SAME
 * encoding the worker's `RelationStoreLive` reads with, so a discharge of
 * `Moderate.over(platform)` finds these seeded tuples (the write→read seam, ADR
 * 0107). Never a bare `"platform"` literal: that would not match the `type:id`
 * read key, leaving the seeded founder denied.
 */
import {key, platform} from "@kampus/authz";
import {and, eq, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {seedSchema as schema} from "./schema.ts";

// The founder grant is exactly this relation on this object — hardcoded so an invalid
// founder tuple (any other relation/object) is unrepresentable. The object is the
// canonical `key(platform)` (`"platform:platform"`), shared with the worker read so
// the write and read keys cannot diverge. General per-resource assignment (admin,
// per-community roles) lives on the Admin child, not here.
export const MODERATES = "moderates";
export const PLATFORM = key(platform);

export interface SeedResult {
	/** Size of the `role='moderator'` cohort read (the founders to mint). */
	founders: number;
	/** Tuples newly minted — `0` on a re-run (idempotent) or an empty cohort. */
	inserted: number;
}

export interface FounderTuple {
	readonly subject: string;
	readonly relation: string;
	readonly object: string;
}

export type SeedDb = ReturnType<typeof drizzle<typeof schema>>;

export const makeSeedDb = (d1: D1Database): SeedDb => drizzle(d1, {schema});

/**
 * Mint the founder cohort (`role='moderator'`) as `(id, "moderates", key(platform))`
 * tuples. Returns `{founders, inserted}` so the caller reports the cases
 * distinctly — a re-run reads `inserted: 0` (idempotent).
 */
export const seedFounders = async (db: SeedDb): Promise<SeedResult> => {
	const founders = await db
		.select({id: schema.user.id})
		.from(schema.user)
		.where(eq(schema.user.role, "moderator"))
		.all();
	if (founders.length === 0) return {founders: 0, inserted: 0};
	const result = await db
		.insert(schema.relationTuple)
		.values(founders.map((f) => ({subject: f.id, relation: MODERATES, object: PLATFORM})))
		.onConflictDoNothing()
		.run();
	return {founders: founders.length, inserted: result.meta.changes};
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
