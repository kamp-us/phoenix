/**
 * Returns an **unexecuted** drizzle `UPDATE` against `user_profile.total_karma` —
 * pasaport's implementation of the `KarmaBump` contract VOTE owns (`vote/Vote.ts`,
 * dependency inversion). `fate/layers.ts` wraps it in `Layer.succeed(KarmaBump, …)`;
 * the Vote service includes the statement inside its `batch((db) => [...])` so the
 * karma adjustment commits atomically with the vote. Vote never imports this module.
 */
import {eq, sql} from "drizzle-orm";
import type {DrizzleDb} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";

// `delta` may be negative (vote retraction). Never call `.run()` on the result —
// it's meant for a `batch((db) => [...])` tuple. For a one-off bump outside a
// batch, wrap in `run((db) => karmaBumpStatement(db, ...).run())`.
export function karmaBumpStatement(db: DrizzleDb, userId: string, delta: number) {
	return db
		.update(schema.userProfile)
		.set({totalKarma: sql`${schema.userProfile.totalKarma} + ${delta}`})
		.where(eq(schema.userProfile.userId, userId));
}
