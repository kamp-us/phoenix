/**
 * `VouchLedger` — the persistence seam for the authorship-vouch act (#1206/#1289). The
 * AUTHORITY to vouch is the {@link ./vouch.ts | Vouch} capability discharged at the
 * resolver, never here (ADR 0013).
 *
 * **Active-by-existence (#1289).** There is no `withdrawn`/`active` column: a vouch is
 * active iff its row exists AND the candidate is still a `çaylak`. `withdraw` deletes the
 * row and a promotion flips the tier — either way the slot returns, and "a withdrawn
 * vouch" is unrepresentable.
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
 * `alreadyVouched` consumes no fresh slot, so it succeeds even when the voucher is at the
 * cap. The split lets the resolver map outcomes without re-deriving the cap arithmetic
 * (ADR 0013).
 */
export type VouchOutcome = "recorded" | "alreadyVouched" | "capReached";

export class VouchLedger extends Context.Service<
	VouchLedger,
	{
		/**
		 * Enforces {@link ./standing.ts | VOUCH_CONCURRENT_CAP} as part of the write: one
		 * guarded statement, so two concurrent vouches can never both pass the cap and both
		 * insert (#1362). The cap invariant lives here, not at the resolver (ADR 0013).
		 */
		readonly castVouch: (input: {
			voucherId: string;
			candidateId: string;
			now: Date;
		}) => Effect.Effect<{outcome: VouchOutcome}>;

		readonly has: (input: VouchKey) => Effect.Effect<boolean>;

		/** The cap input: vouches whose candidate is still `çaylak`. */
		readonly activeCountFor: (voucherId: string) => Effect.Effect<number>;

		/** The vouch half of the order-independent tandem (#1289); active as above. */
		readonly hasActiveFor: (candidateId: string) => Effect.Effect<boolean>;

		/** Idempotent: withdrawing an absent vouch is a no-op (`withdrawn: false`). */
		readonly withdraw: (input: VouchKey) => Effect.Effect<{withdrawn: boolean}>;
	}
>()("@kampus/kunye/VouchLedger") {}

export const VouchLedgerLive = Layer.effect(VouchLedger)(
	Effect.gen(function* () {
		// `orDieAccess`: see .patterns/feature-services.md.
		const {run, batch} = orDieAccess(yield* Drizzle);

		// The cap check and the insert are ONE guarded `INSERT … SELECT … WHERE
		// (active-count subquery) < cap` statement, closing #1362's check-then-act race:
		// SQLite evaluates the subquery and inserts inside a single write statement, and D1
		// serializes writers onto one primary. The existence probe rides the same batch so
		// the zero-insert case is disambiguated without a second round-trip that could read
		// a different world.
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
			// The cap was already enforced atomically above — this only labels which
			// zero-insert case occurred, so it can't reopen the race.
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

			// The inner-join to `user` is what makes a promotion return the slot without
			// touching the vouch row: a `yazar` candidate drops out of the cap count.
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

			// Tier-filtered like `activeCountFor`: a promoted candidate's persisted row no
			// longer counts as active (#1324).
			hasActiveFor: Effect.fn("VouchLedger.hasActiveFor")(function* (candidateId: string) {
				const row = yield* run((db) =>
					db
						.select({voucherId: schema.authorshipVouch.voucherId})
						.from(schema.authorshipVouch)
						.innerJoin(schema.user, eq(schema.user.id, schema.authorshipVouch.candidateId))
						.where(
							and(
								eq(schema.authorshipVouch.candidateId, candidateId),
								eq(schema.user.tier, "çaylak"),
							),
						)
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
