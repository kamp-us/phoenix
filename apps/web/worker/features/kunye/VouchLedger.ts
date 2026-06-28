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
import {VOUCH_CONCURRENT_CAP} from "./standing.ts";

export interface VouchKey {
	voucherId: string;
	candidateId: string;
}

/**
 * The three outcomes of {@link VouchLedger.castVouch}, the single cap-enforcing write:
 *
 *  - `recorded` — a NEW vouch row was inserted (the voucher was under the cap).
 *  - `alreadyVouched` — the row already existed: an idempotent re-vouch, a success that
 *    consumes no fresh slot (so it is allowed even when the voucher is at the cap).
 *  - `capReached` — no row existed and the cap blocked the insert; the caller surfaces
 *    {@link ./errors.ts | VouchLimitReached}.
 *
 * The split lets the resolver map `capReached` to the denial and `recorded`/`alreadyVouched`
 * to a success — without the resolver ever re-deriving the cap arithmetic (ADR 0013).
 */
export type VouchOutcome = "recorded" | "alreadyVouched" | "capReached";

export class VouchLedger extends Context.Service<
	VouchLedger,
	{
		/**
		 * Record `voucherId` vouching for `candidateId`, **enforcing the
		 * {@link ./standing.ts | VOUCH_CONCURRENT_CAP} as part of the write** — the
		 * single, atomic vouch-insertion seam (#1362). The cap-check and the insert are
		 * one guarded `INSERT … SELECT … WHERE active_count < cap` statement, so two
		 * concurrent vouches can never both pass the cap and both insert (the
		 * check-then-act race the inline resolver enforcement had). Idempotent on the
		 * composite PK — a re-vouch is `alreadyVouched`, never a fresh slot. The cap
		 * invariant lives here, not at the resolver (ADR 0013); see {@link VouchOutcome}.
		 */
		readonly castVouch: (input: {
			voucherId: string;
			candidateId: string;
			now: Date;
		}) => Effect.Effect<{outcome: VouchOutcome}>;

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
		const {run, batch} = orDieAccess(yield* Drizzle);

		// The cap-enforcing insert is ONE guarded statement, so the cap check and the
		// insert are not separable round-trips another vouch can interleave between
		// (#1362's check-then-act race). The guard is `INSERT … SELECT <values> WHERE
		// (active-count subquery) < cap`: SQLite evaluates the count subquery and
		// performs the insert inside a single write statement, and D1 serializes writers
		// onto its one primary SQLite — so a concurrent vouch's statement runs after this
		// one commits and its subquery sees this row. Same single-statement-guard family
		// as `Pasaport.promoteToYazar`'s conditional `UPDATE … WHERE tier = 'çaylak'`
		// (ADR 0014). It runs in a batch with an existence probe so the zero-insert case
		// — cap-blocked vs. idempotent re-vouch — is disambiguated atomically, in the same
		// transaction, without a second round-trip that could read a different world.
		const castVouch = Effect.fn("VouchLedger.castVouch")(function* (input: {
			voucherId: string;
			candidateId: string;
			now: Date;
		}) {
			// `{mode: "timestamp"}` stores epoch SECONDS (drizzle integer codec); a raw
			// `sql` SELECT bypasses that codec, so encode the seconds the column expects here.
			const createdAtSeconds = Math.floor(input.now.getTime() / 1000);
			const [insertResult, existing] = yield* batch((db) => {
				const activeCount = db
					.select({n: sql<number>`count(*)`})
					.from(schema.authorshipVouch)
					.innerJoin(schema.user, eq(schema.user.id, schema.authorshipVouch.candidateId))
					.where(
						and(
							eq(schema.authorshipVouch.voucherId, input.voucherId),
							eq(schema.user.tier, "çaylak"),
						),
					);
				const guardedInsert = db
					.insert(schema.authorshipVouch)
					.select(
						sql`select ${input.voucherId}, ${input.candidateId}, ${createdAtSeconds} where (${activeCount}) < ${VOUCH_CONCURRENT_CAP}`,
					)
					.onConflictDoNothing();
				const existenceProbe = db
					.select({voucherId: schema.authorshipVouch.voucherId})
					.from(schema.authorshipVouch)
					.where(
						and(
							eq(schema.authorshipVouch.voucherId, input.voucherId),
							eq(schema.authorshipVouch.candidateId, input.candidateId),
						),
					)
					.limit(1);
				return [guardedInsert, existenceProbe] as const;
			});
			if (insertResult.meta.changes > 0) return {outcome: "recorded" as const};
			// Zero rows inserted: the row already existed (idempotent re-vouch) or the cap
			// blocked a new one. The cap was already enforced atomically above — this only
			// labels which zero-insert case occurred, so it can't reopen the race.
			return {outcome: existing.length > 0 ? ("alreadyVouched" as const) : ("capReached" as const)};
		});

		return {
			castVouch,

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
