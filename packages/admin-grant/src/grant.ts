/**
 * The pure core of the admin-grant CLI (ADR 0107). The `Admin` capability is
 * relation-backed: admin authority IS the `(subject, "admin", key(platform))` tuple
 * in `relation_tuple`, so granting/revoking admin is minting/dropping that tuple —
 * the offline direct-D1 path, NOT a runtime worker route (the deleted `/api/admin/*`
 * fail-open shape, CLAUDE.md "Sözlük seed"). A `node:sqlite`-free, unit-testable core
 * (statement builders + assign/revoke/list over a `D1Database` slice) + a thin Effect
 * bin, the `@kampus/moderator-grant` idiom, here writing the tuple `@kampus/founder-seed`
 * writes for moderators.
 *
 * The grant is selectable by `id` OR `username` (an admin is granted by handle in
 * practice); the selector is resolved to the subject id through the `user` table, so a
 * grant for a non-existent user is reported distinctly (`subject: null`) rather than
 * minting a dangling tuple.
 *
 * The `object` key is `@kampus/authz`'s canonical `key(platform)` (`"platform:platform"`)
 * — the SAME encoding the worker's `RelationStoreLive` reads with, so a discharge of
 * `Admin.over(platform)` finds the granted tuple (the write→read seam, ADR 0107). Never
 * a bare `"platform"` literal: that would not match the `type:id` read key, leaving the
 * granted admin denied.
 */
import {key, platform} from "@kampus/authz";
import {and, eq, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {grantSchema as schema} from "./schema.ts";

// The admin grant is exactly this relation on this object — hardcoded so an invalid
// admin tuple (any other relation/object) is unrepresentable. The object is the
// canonical `key(platform)`, shared with the worker read so the write and read keys
// cannot diverge.
export const ADMIN = "admin";
export const PLATFORM = key(platform);

export type Selector =
	| {readonly by: "id"; readonly value: string}
	| {readonly by: "username"; readonly value: string};

export interface AssignResult {
	/** The resolved subject id, or `null` if no user matched the selector. */
	subject: string | null;
	/** Tuples newly minted — `0` on a re-run (idempotent) or when no user matched. */
	inserted: number;
	selector: Selector;
}

export interface RevokeResult {
	/** The resolved subject id, or `null` if no user matched the selector. */
	subject: string | null;
	/** Tuples removed — `0` when the subject was not an admin or no user matched. */
	removed: number;
	selector: Selector;
}

export interface AdminTuple {
	readonly subject: string;
	readonly relation: string;
	readonly object: string;
}

export type GrantDb = ReturnType<typeof drizzle<typeof schema>>;

export const makeGrantDb = (d1: D1Database): GrantDb => drizzle(d1, {schema});

const whereSelector = (selector: Selector) =>
	selector.by === "id"
		? eq(schema.user.id, selector.value)
		: eq(schema.user.username, selector.value);

/** Resolve a selector to the subject's user id, or `undefined` if no such user. */
const resolveSubject = async (db: GrantDb, selector: Selector): Promise<string | undefined> => {
	const row = await db
		.select({id: schema.user.id})
		.from(schema.user)
		.where(whereSelector(selector))
		.get();
	return row?.id;
};

const whereTuple = (subject: string) =>
	and(
		eq(schema.relationTuple.subject, subject),
		eq(schema.relationTuple.relation, ADMIN),
		eq(schema.relationTuple.object, PLATFORM),
	);

/**
 * Grant platform-admin authority: mint `(subject, "admin", key(platform))`, keyed by
 * id or username. Idempotent (`onConflictDoNothing` against the composite PK), so a
 * re-run mints nothing new. Returns `{subject, inserted}` so the caller reports "no
 * such user" (`subject: null`) distinctly from "already an admin" (`inserted: 0`).
 */
export const assignAdmin = async (db: GrantDb, selector: Selector): Promise<AssignResult> => {
	const subject = await resolveSubject(db, selector);
	if (subject === undefined) return {subject: null, inserted: 0, selector};
	const result = await db
		.insert(schema.relationTuple)
		.values({subject, relation: ADMIN, object: PLATFORM})
		.onConflictDoNothing()
		.run();
	return {subject, inserted: result.meta.changes, selector};
};

/**
 * Revoke platform-admin authority: drop the `(subject, "admin", key(platform))`
 * tuple. A revoked tuple denies the very next `Admin.over(platform)` discharge (the
 * store reads fresh per call — ADR 0098/0107). Returns the removed-row count so the
 * caller reports "was not an admin" (`removed: 0`) distinctly from a real revoke.
 */
export const revokeAdmin = async (db: GrantDb, selector: Selector): Promise<RevokeResult> => {
	const subject = await resolveSubject(db, selector);
	if (subject === undefined) return {subject: null, removed: 0, selector};
	const result = await db.delete(schema.relationTuple).where(whereTuple(subject)).run();
	return {subject, removed: result.meta.changes, selector};
};

/** List the current admins (the `admin`-over-platform subjects) — the audit read the CLI prints. */
export const listAdmins = async (db: GrantDb): Promise<ReadonlyArray<{subject: string}>> => {
	const rows = await db
		.select({subject: schema.relationTuple.subject})
		.from(schema.relationTuple)
		.where(and(eq(schema.relationTuple.relation, ADMIN), eq(schema.relationTuple.object, PLATFORM)))
		.orderBy(sql`${schema.relationTuple.subject} ASC`)
		.all();
	return rows;
};
