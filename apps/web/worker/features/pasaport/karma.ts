/**
 * Pasaport's implementation of the `KarmaBump` contract VOTE owns (`vote/Vote.ts`,
 * dependency inversion): the **unexecuted** `total_karma` UPDATE PLUS its
 * append-only `karma_event` ledger row (#2592), so every bump leaves a
 * reconstructable origin record co-committed with the balance change.
 * `fate/layers.ts` wraps this in `Layer.succeed(KarmaBump, …)`; the Vote service
 * includes both statements in its `batch((db) => [...])` so bump + event commit
 * atomically with the vote, or not at all. Vote never imports this module — it
 * passes the {@link KarmaBumpInput} context and this side owns the karma schema.
 */
import {and, eq, sql} from "drizzle-orm";
import type {DrizzleDb, Stmt} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {KarmaBumpInput} from "../vote/Vote.ts";

/**
 * The bump + its provenance event, in that order. `delta` may be negative (a vote
 * retraction records a `-1` `karma_event`, never a deletion of the prior row — the
 * ledger is append-only, so `SUM(delta)` reconciles to `total_karma`). Never call
 * `.run()` on either — they are meant for a `batch((db) => [...])` tuple.
 *
 * BOTH statements carry `input.guard` — the pre-mutation vote-change predicate — so a
 * duplicate cast that raced the out-of-batch idempotency probe writes NEITHER the delta
 * NOR a ledger row, keeping the two in lockstep (#2552). The event is an
 * `INSERT … SELECT … WHERE guard` (a plain `.values()` can't carry a predicate) — the
 * same guarded-insert idiom as bildirim's `insertUnlessUnreadStatement`; its raw select
 * bypasses drizzle's `{mode:"timestamp"}` codec, so `created_at` is bound as the epoch
 * SECONDS the column stores.
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
