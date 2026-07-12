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
import {eq, sql} from "drizzle-orm";
import type {DrizzleDb, Stmt} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {KarmaBumpInput} from "../vote/Vote.ts";

/**
 * The bump + its provenance event, in that order. `delta` may be negative (a vote
 * retraction records a `-1` `karma_event`, never a deletion of the prior row — the
 * ledger is append-only, so `SUM(delta)` reconciles to `total_karma`). Never call
 * `.run()` on either — they are meant for a `batch((db) => [...])` tuple.
 */
export function karmaBumpStatements(db: DrizzleDb, input: KarmaBumpInput): readonly [Stmt, Stmt] {
	const bump = db
		.update(schema.userProfile)
		.set({totalKarma: sql`${schema.userProfile.totalKarma} + ${input.delta}`})
		.where(eq(schema.userProfile.userId, input.recipientId));

	const event = db.insert(schema.karmaEvent).values({
		id: crypto.randomUUID(),
		userId: input.recipientId,
		delta: input.delta,
		sourceKind: input.source.kind,
		sourceId: input.source.id,
		reason: input.reason,
		createdAt: input.at,
	});

	return [bump, event];
}
