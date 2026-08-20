/**
 * CaylakVisibility — the yazar's "çaylak katkılarını yerinde göster" opt-in store
 * (#6422, epic #4306), the {@link ../mute/Mute Mute} shape keyed on one user instead
 * of two: a `caylak_visibility_preference` row means this account opted in, its
 * absence means it did not.
 *
 * The state is a discriminated union rather than a `{optedIn, setAt}` pair, so
 * "opted in but we don't know when" cannot be built — the same unrepresentability the
 * table gets from having no `false` row.
 *
 * `set` is idempotent (probe-then-write, like `Mute.set`): opting in twice, or opting
 * out when never opted in, writes nothing and returns `changed: false`.
 *
 * Scope: storage + domain seam only. The yazar floor lives at the mutation
 * (`SetCaylakVisibility`), the flag gate at the resolvers, and nothing reads this
 * preference to change what anyone sees yet — that is a sibling slice.
 */
import {eq} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";

/** An account's opt-in state: opted out carries no timestamp, opted in always does. */
export type CaylakVisibilityState =
	| {readonly optedIn: false}
	| {readonly optedIn: true; readonly setAt: Date};

/** The post-write state plus `changed: false` on an idempotent no-op. */
export type CaylakVisibilitySetResult = CaylakVisibilityState & {readonly changed: boolean};

export interface CaylakVisibilitySetInput {
	readonly userId: string;
	/** Presence intent: `true` opts in, `false` opts out (the `MuteSetInput.value` shape). */
	readonly value: boolean;
}

const OPTED_OUT: CaylakVisibilityState = {optedIn: false};

export class CaylakVisibility extends Context.Service<
	CaylakVisibility,
	{
		/**
		 * One account's own opt-in state. A missing account id short-circuits to
		 * opted-out with no read.
		 */
		readonly read: (userId: string | null | undefined) => Effect.Effect<CaylakVisibilityState>;
		/**
		 * Set the account's opt-in presence to `value`, idempotently (probe-then-write).
		 * A matching state is a no-op (`changed: false`, no write).
		 */
		readonly set: (input: CaylakVisibilitySetInput) => Effect.Effect<CaylakVisibilitySetResult>;
	}
>()("caylak-visibility/CaylakVisibility") {}

export const CaylakVisibilityLive = Layer.effect(CaylakVisibility)(
	Effect.gen(function* () {
		// `orDieAccess`: DB failures are defects (domain-boundary rule), so both public
		// signatures carry no error and `R` stays `never`.
		const {run, batch} = orDieAccess(yield* Drizzle);

		const probe = (userId: string) =>
			run((db) =>
				db
					.select({setAt: schema.caylakVisibilityPreference.setAt})
					.from(schema.caylakVisibilityPreference)
					.where(eq(schema.caylakVisibilityPreference.userId, userId))
					.get(),
			);

		return {
			read: Effect.fn("CaylakVisibility.read")(function* (userId: string | null | undefined) {
				if (!userId) return OPTED_OUT;
				const row = yield* probe(userId);
				return row ? ({optedIn: true, setAt: row.setAt} as const) : OPTED_OUT;
			}),

			set: Effect.fn("CaylakVisibility.set")(function* (input: CaylakVisibilitySetInput) {
				const existing = yield* probe(input.userId);
				if (input.value === (existing != null)) {
					return existing
						? ({optedIn: true, setAt: existing.setAt, changed: false} as const)
						: ({optedIn: false, changed: false} as const);
				}

				if (!input.value) {
					yield* batch(
						(db) =>
							[
								db
									.delete(schema.caylakVisibilityPreference)
									.where(eq(schema.caylakVisibilityPreference.userId, input.userId)),
							] as const,
					);
					return {optedIn: false, changed: true} as const;
				}

				const setAt = new Date();
				yield* batch(
					(db) =>
						[
							db
								.insert(schema.caylakVisibilityPreference)
								.values({userId: input.userId, setAt})
								.onConflictDoNothing(),
						] as const,
				);
				return {optedIn: true, setAt, changed: true} as const;
			}),
		};
	}),
);
