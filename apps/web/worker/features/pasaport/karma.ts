/**
 * Karma bump helper — pure drizzle statement factory.
 *
 * `karmaBumpStatement(db, userId, delta)` returns an **unexecuted** drizzle
 * `UPDATE` against `user_profile.total_karma`. It is pasaport's implementation
 * of the `KarmaBump` contract VOTE owns (`vote/Vote.ts` — dependency
 * inversion, audit A2): `fate/layers.ts` wraps it in `Layer.succeed(KarmaBump,
 * …)` at composition, and the Vote service includes the provided statement
 * inside its `batch((db) => [...])` so the karma adjustment commits atomically
 * with the vote insert / score update. Vote itself never imports this module.
 *
 * This file owns no Effect, no service, no D1 binding lookup — it's a thin
 * statement builder consumers compose into their own batch tuples.
 */
import {eq, sql} from "drizzle-orm";
import type {DrizzleDb} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";

/**
 * Build the unexecuted `UPDATE user_profile SET total_karma = total_karma + ?`
 * statement. `delta` may be negative (vote retraction).
 *
 * The Vote service uses this inside `batch((db) => [...])` — never call
 * `.run()` on the result. If you need a one-off karma bump outside a batch,
 * wrap the call in `run((db) => karmaBumpStatement(db, ...).run())` after
 * destructuring `run` off the Drizzle service.
 */
export function karmaBumpStatement(db: DrizzleDb, userId: string, delta: number) {
	return db
		.update(schema.userProfile)
		.set({totalKarma: sql`${schema.userProfile.totalKarma} + ${delta}`})
		.where(eq(schema.userProfile.userId, userId));
}
