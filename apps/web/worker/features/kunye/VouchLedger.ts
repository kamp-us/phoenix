/**
 * `VouchLedger` — the D1-backed store of the authorship-vouch act (#1206, extended in
 * #1289): records a yazar's vouch for a çaylak (preserving the vouching actor), reads
 * back whether a vouch exists, counts a yazar's active vouches for the cap, and
 * withdraws a vouch. The recorded act is the `authorship_vouch` table; the AUTHORITY
 * to vouch (the yazar floor) is the {@link ./vouch.ts | Vouch} capability discharged
 * at the resolver, never here — this service is the persistence seam only (ADR 0013:
 * domain write in the service, the authority check at the gate).
 *
 * **Active-by-existence (#1289).** A vouch's lifecycle is encoded in the *presence* of
 * its row plus the candidate's tier — no `withdrawn`/`active` column, so #1289 reuses
 * the #1206 (migration 0013) schema with no migration. A vouch is **active** iff its
 * row exists *and* the candidate is still a `çaylak` (pending): `withdraw` deletes the
 * row (the slot returns), and a promotion flips the candidate to `yazar` (the row
 * persists as the successful-vouch record but no longer counts as active — the slot
 * also returns). "A withdrawn vouch" is therefore unrepresentable; the active set is
 * exactly `{rows whose candidate is still çaylak}`.
 *
 * Idempotency lives in the table: the composite PK `(voucher_id, candidate_id)` +
 * `onConflictDoNothing` makes a re-vouch by the same yazar a no-op success (the
 * `content_report` / `user_vote` precedent).
 */
import {and, eq, sql} from "drizzle-orm";
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

		/** Whether `voucherId` has already vouched for `candidateId` (the row exists). */
		readonly has: (input: VouchKey) => Effect.Effect<boolean>;

		/**
		 * The number of **active** vouches `voucherId` currently holds (the cap input,
		 * D5). Active = a vouch row whose candidate is still a `çaylak`; a promoted
		 * candidate's vouch is excluded (its slot returned), so the count rations only
		 * the yazar's *pending* stake. A withdrawn vouch has no row, so it isn't counted.
		 */
		readonly activeCountFor: (voucherId: string) => Effect.Effect<number>;

		/**
		 * Whether `candidateId` has **≥1 active vouch** from any yazar — the vouch half
		 * of the order-independent tandem (#1289). `true` once any unwithdrawn vouch row
		 * names this candidate.
		 */
		readonly hasActiveFor: (candidateId: string) => Effect.Effect<boolean>;

		/**
		 * Withdraw `voucherId`'s vouch for `candidateId` — delete the row, returning the
		 * slot. Idempotent: withdrawing an absent/already-withdrawn vouch is a no-op
		 * (`withdrawn: false`).
		 */
		readonly withdraw: (input: VouchKey) => Effect.Effect<{withdrawn: boolean}>;
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

			// Active = the vouch row exists AND the candidate is still `çaylak`. The
			// inner-join to `user` is what makes a promotion *return the slot* without
			// touching the vouch row: once the candidate is `yazar` the row no longer
			// matches `tier = 'çaylak'`, so it drops out of the cap count.
			activeCountFor: Effect.fn("VouchLedger.activeCountFor")(function* (voucherId: string) {
				const row = yield* run((db) =>
					db
						.select({n: sql<number>`count(*)`})
						.from(schema.authorshipVouch)
						.innerJoin(schema.user, eq(schema.user.id, schema.authorshipVouch.candidateId))
						.where(
							and(eq(schema.authorshipVouch.voucherId, voucherId), eq(schema.user.tier, "çaylak")),
						)
						.get(),
				);
				return row?.n ?? 0;
			}),

			hasActiveFor: Effect.fn("VouchLedger.hasActiveFor")(function* (candidateId: string) {
				const row = yield* run((db) =>
					db
						.select({voucherId: schema.authorshipVouch.voucherId})
						.from(schema.authorshipVouch)
						.where(eq(schema.authorshipVouch.candidateId, candidateId))
						.limit(1)
						.get(),
				);
				return row !== undefined;
			}),

			withdraw: Effect.fn("VouchLedger.withdraw")(function* (input: VouchKey) {
				const result = yield* run((db) =>
					db
						.delete(schema.authorshipVouch)
						.where(
							and(
								eq(schema.authorshipVouch.voucherId, input.voucherId),
								eq(schema.authorshipVouch.candidateId, input.candidateId),
							),
						)
						.run(),
				);
				return {withdrawn: result.meta.changes > 0};
			}),
		};
	}),
);
