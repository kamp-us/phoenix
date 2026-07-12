/**
 * `FlagOverrideStore` — the durable, all-stages, `requireAdmin`-written override substrate
 * over `flag_override_event` (admin-console epic #2711, #2741). It generalizes the dev-only
 * cookie override (`dev-override.ts`, #622) into an append-only, auditable D1 log projected to
 * current state: every admin flip appends one row (actor id, flag key, on/off/clear, time), and
 * the effective override is the latest-event projection (`flag-override.ts`). This is the store
 * the `Flags.getBoolean` wrapper (`withRuntimeOverrides`) reads and the flag-flip mutation writes.
 *
 * Read fail-soft is load-bearing (epic #2711 story 8): `getActiveOverride` and
 * `listActiveOverrides` have error channel `never` — a D1 failure degrades to "no override" (the
 * read then delegates to the real Flagship evaluation), so the override layer can never turn the
 * never-throwing flag contract fail-open. The `record` write dies on a D1 failure (a defect, not a
 * domain error, matching the pasaport write path), so the mutation's error channel stays domain-only.
 */
import {desc, eq} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieDrizzle} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {
	type FlagOverrideAction,
	type FlagOverrideEvent,
	type FlagOverrideEventRow,
	resolveFlagOverride,
	selectActiveOverrides,
} from "./flag-override.ts";

export class FlagOverrideStore extends Context.Service<
	FlagOverrideStore,
	{
		/**
		 * Append one override event for a flag key, stamped with the acting admin's account id.
		 * Dies on a D1 failure (a defect) so the caller's error channel stays domain-only.
		 */
		readonly record: (input: {
			readonly flagKey: string;
			readonly action: FlagOverrideAction;
			readonly actorId: string;
		}) => Effect.Effect<void>;
		/**
		 * The flag's effective runtime override, or `undefined` for no active override. Fail-soft
		 * (`E = never`): a D1 failure resolves `undefined` (delegate to the real evaluation), so the
		 * `getBoolean` wrapper this feeds never throws.
		 */
		readonly getActiveOverride: (flagKey: string) => Effect.Effect<boolean | undefined>;
		/**
		 * The map of flag key → forced boolean for every key with an active override — the flag-state
		 * view's read. Fail-soft (`E = never`): a D1 failure resolves an empty map (the view then shows
		 * all-real-evaluation), never a broken admin read.
		 */
		readonly listActiveOverrides: () => Effect.Effect<ReadonlyMap<string, boolean>>;
	}
>()("@kampus/flagship/FlagOverrideStore") {}

/**
 * The Drizzle-backed adapter. `run` is captured at layer build, so each method's Effect carries
 * no `R` — a drop-in the isolate-scoped `Flags` wrapper closes over (mirroring `EmailDeliveryLog`).
 */
export const FlagOverrideStoreLive: Layer.Layer<FlagOverrideStore, never, Drizzle> = Layer.effect(
	FlagOverrideStore,
	Effect.gen(function* () {
		const {run} = yield* Drizzle;

		// The latest event for one key, projected to its effective override. Fail-soft: any D1
		// error logs and resolves `undefined` (the real evaluation wins), keeping `E = never`.
		const readActiveOverride = (flagKey: string): Effect.Effect<boolean | undefined> =>
			run((db) =>
				db
					.select({
						action: schema.flagOverrideEvent.action,
						createdAt: schema.flagOverrideEvent.createdAt,
					})
					.from(schema.flagOverrideEvent)
					.where(eq(schema.flagOverrideEvent.flagKey, flagKey))
					.orderBy(desc(schema.flagOverrideEvent.createdAt), desc(schema.flagOverrideEvent.id))
					.limit(1)
					.then((rows): boolean | undefined => {
						const row = rows[0];
						if (!row) return undefined;
						const latest: FlagOverrideEvent = {
							action: row.action,
							createdAt: row.createdAt ?? new Date(0),
						};
						return resolveFlagOverride(latest);
					}),
			).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning(
						`flag-override: read of "${flagKey}" failed — delegating to real evaluation`,
						cause,
					).pipe(Effect.as(undefined)),
				),
			);

		return FlagOverrideStore.of({
			record: ({flagKey, action, actorId}) =>
				run((db) =>
					db.insert(schema.flagOverrideEvent).values({
						id: crypto.randomUUID(),
						flagKey,
						action,
						actorId,
						createdAt: new Date(),
					}),
				).pipe(Effect.asVoid, orDieDrizzle),

			getActiveOverride: readActiveOverride,

			listActiveOverrides: () =>
				run((db) =>
					db
						.select({
							id: schema.flagOverrideEvent.id,
							flagKey: schema.flagOverrideEvent.flagKey,
							action: schema.flagOverrideEvent.action,
							createdAt: schema.flagOverrideEvent.createdAt,
						})
						.from(schema.flagOverrideEvent),
				).pipe(
					Effect.map(
						(rows): ReadonlyMap<string, boolean> =>
							selectActiveOverrides(
								rows.map(
									(row): FlagOverrideEventRow => ({
										id: row.id,
										flagKey: row.flagKey,
										action: row.action,
										createdAt: row.createdAt ?? new Date(0),
									}),
								),
							),
					),
					Effect.catchCause((cause) =>
						Effect.logWarning(
							"flag-override: roll-up read failed — degrading to no active overrides",
							cause,
						).pipe(Effect.as(new Map<string, boolean>() as ReadonlyMap<string, boolean>)),
					),
				),
		});
	}),
);
