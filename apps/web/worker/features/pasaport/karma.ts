/**
 * Pasaport's implementation of the `KarmaBump` contract Vote owns. Vote never imports
 * this module — it passes {@link KarmaBumpInput} and this side owns the karma schema.
 */
import {and, eq, sql} from "drizzle-orm";
import type {DrizzleDb, Stmt} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {KarmaBumpInput} from "../vote/Vote.ts";

/**
 * Never call `.run()` on either statement — they belong in a `batch((db) => [...])`.
 *
 * The ledger is append-only: a retraction records a `-1` event, never a deletion, so
 * `SUM(delta)` reconciles to `total_karma`. BOTH statements must carry `input.guard`, so
 * a duplicate cast that raced the idempotency probe writes neither (#2552). The event is
 * an `INSERT … SELECT … WHERE guard` because a plain `.values()` can't carry a predicate;
 * that raw select bypasses drizzle's `{mode:"timestamp"}` codec, hence the explicit
 * epoch-SECONDS binding below.
 */
export function karmaBumpStatements(db: DrizzleDb, input: KarmaBumpInput): readonly [Stmt, Stmt] {
	const bump = db
		.update(schema.userProfile)
		.set({totalKarma: sql`${schema.userProfile.totalKarma} + ${input.delta}`})
		.where(and(eq(schema.userProfile.userId, input.recipientId), input.guard));

	const createdAtSeconds = Math.floor(input.at.getTime() / 1000);
	const event = db
		.insert(schema.karmaEvent)
		.select(
			sql`select ${crypto.randomUUID()}, ${input.recipientId}, ${input.delta}, ${input.source.kind}, ${input.source.id}, ${input.reason}, ${createdAtSeconds} where ${input.guard}`,
		);

	return [bump, event];
}
