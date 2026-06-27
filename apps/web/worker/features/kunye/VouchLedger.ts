/**
 * `VouchLedger` — the D1-backed store of the authorship-vouch act (#1206): records a
 * yazar's vouch for a çaylak (preserving the vouching actor) and reads back whether a
 * vouch exists. The recorded act is the `authorship_vouch` table; the AUTHORITY to
 * vouch (the yazar floor) is the {@link ./vouch.ts | Vouch} capability discharged at
 * the resolver, never here — this service is the persistence seam only (ADR 0013:
 * domain write in the service, the authority check at the gate).
 *
 * Idempotency lives in the table: the composite PK `(voucher_id, candidate_id)` +
 * `onConflictDoNothing` makes a re-vouch by the same yazar a no-op success (the
 * `content_report` / `user_vote` precedent).
 */
import {and, eq} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";

export interface VouchKey {
	voucherId: string;
	candidateId: string;
}

export class VouchLedger extends Context.Service<
	VouchLedger,
	{
		/**
		 * Record `voucherId` vouching for `candidateId`. Idempotent on the composite
		 * PK — a re-vouch by the same yazar for the same çaylak is a no-op success
		 * (`recorded: false`).
		 */
		readonly record: (input: {
			voucherId: string;
			candidateId: string;
			now: Date;
		}) => Effect.Effect<{recorded: boolean}>;

		/** Whether `voucherId` has already vouched for `candidateId`. */
		readonly has: (input: VouchKey) => Effect.Effect<boolean>;
	}
>()("@kampus/kunye/VouchLedger") {}

export const VouchLedgerLive = Layer.effect(VouchLedger)(
	Effect.gen(function* () {
		// `orDieAccess`: infra failures die as defects, so public signatures carry no
		// `DrizzleError` and `R` stays `never` (`.patterns/feature-services.md`).
		const {run} = orDieAccess(yield* Drizzle);

		return {
			record: Effect.fn("VouchLedger.record")(function* (input: {
				voucherId: string;
				candidateId: string;
				now: Date;
			}) {
				const result = yield* run((db) =>
					db
						.insert(schema.authorshipVouch)
						.values({
							voucherId: input.voucherId,
							candidateId: input.candidateId,
							createdAt: input.now,
						})
						.onConflictDoNothing()
						.run(),
				);
				return {recorded: result.meta.changes > 0};
			}),

			has: Effect.fn("VouchLedger.has")(function* (input: VouchKey) {
				const row = yield* run((db) =>
					db
						.select({voucherId: schema.authorshipVouch.voucherId})
						.from(schema.authorshipVouch)
						.where(
							and(
								eq(schema.authorshipVouch.voucherId, input.voucherId),
								eq(schema.authorshipVouch.candidateId, input.candidateId),
							),
						)
						.limit(1)
						.get(),
				);
				return row !== undefined;
			}),
		};
	}),
);
