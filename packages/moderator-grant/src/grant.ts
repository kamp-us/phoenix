/**
 * The pure core of the moderator-grant CLI (ADR 0098 §1). `user.role` is the
 * server-managed moderation capability, granted only by a server-side path — this
 * offline direct-D1 script, NOT a runtime worker route (the deleted `/api/admin/*`
 * fail-open shape, CLAUDE.md "Sözlük seed"). A `node:sqlite`-free, unit-testable
 * core (statement builders + `grant`/`revoke` over a `D1Database` slice) + a thin
 * Effect bin, mirroring `@kampus/preview-seed`.
 *
 * The role is flipped by `id` OR `username` (a moderator is granted by handle in
 * practice). The update is keyed on the chosen selector and never widens.
 */
import {eq, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {grantSchema as schema} from "./schema.ts";

export type Role = "member" | "moderator";

export type Selector =
	| {readonly by: "id"; readonly value: string}
	| {readonly by: "username"; readonly value: string};

export interface GrantResult {
	/** How many user rows had their role set (0 ⇒ no such user). */
	changed: number;
	role: Role;
	selector: Selector;
}

export type GrantDb = ReturnType<typeof drizzle<typeof schema>>;

export const makeGrantDb = (d1: D1Database): GrantDb => drizzle(d1, {schema});

const whereSelector = (selector: Selector) =>
	selector.by === "id"
		? eq(schema.user.id, selector.value)
		: eq(schema.user.username, selector.value);

/**
 * Set a user's `role` to `member` | `moderator`, keyed by id or username. Returns
 * the changed-row count so the caller can report "no such user" (changed === 0)
 * distinctly from a successful flip.
 */
export const setRole = async (
	db: GrantDb,
	selector: Selector,
	role: Role,
): Promise<GrantResult> => {
	const result = await db
		.update(schema.user)
		.set({role, updatedAt: new Date()})
		.where(whereSelector(selector))
		.run();
	return {changed: result.meta.changes, role, selector};
};

/** List the current moderators (id + username) — the audit read the CLI prints. */
export const listModerators = async (
	db: GrantDb,
): Promise<ReadonlyArray<{id: string; username: string | null}>> => {
	const rows = await db
		.select({id: schema.user.id, username: schema.user.username})
		.from(schema.user)
		.where(eq(schema.user.role, "moderator"))
		.orderBy(sql`${schema.user.username} ASC`)
		.all();
	return rows.map((r) => ({id: r.id, username: r.username ?? null}));
};
