/**
 * Flagship admin root list resolver — `flags.state`, the flag-state roll-up (admin-console
 * epic #2711, #2741). `Fate.list` def + `Effect.fn` pair (`.patterns/fate-effect-operations.md`);
 * the list is delivered inline (no source `connection`), so the resolver builds the wire shape.
 *
 * Two gates, both enforced HERE (the store read is unconditional), mirroring `pasaport/lists.ts`:
 *   1. The `phoenix-admin-console` dark-ship flag (`adminConsoleOn`, default-off, ADR 0083). Off ⇒
 *      the invisible `Denied`, so the roll-up never leaks before release.
 *   2. `requireAdmin` (ADR 0107) — `yield* Admin` makes the read unreachable without the
 *      discharged grant, so a non-admin gets the SAME invisible `Denied`.
 *
 * Each flag's `effective` value is read through `Flags.getBoolean` — the SAME override-applied
 * surface a real gate reads — so the view reflects an active override by construction (#2711
 * story 4). `overridden` comes from the store's active-override map. A single-page private read
 * (no live view, no cursor), so `hasNext: false`, mirroring `emailDelivery.failing`.
 */
import {Fate} from "@kampus/fate-effect";
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Admin, requireAdmin} from "../kunye/admin.ts";
import {Denied} from "../kunye/errors.ts";
import {adminConsoleOn} from "./admin-gate.ts";
import {DECLARED_FLAGS} from "./declared-flags.ts";
import {FlagOverrideStore} from "./FlagOverrideStore.ts";
import {Flags} from "./Flags.ts";
import {provideRequestFlags} from "./FlagsContext.ts";
import {toFlagState} from "./shapers.ts";
import type {FlagStateEntity} from "./views.ts";
import {FlagStateView} from "./views.ts";

const FlagsStateArgs = Schema.Struct({});

// The post-gate roll-up read — `Admin`-gated in R (`requireAdmin` provides the grant).
// `yield* Admin` requires the proof; the roll-up is unreachable without a discharged grant.
const flagsStateGated = Effect.fn("flags.stateGated")(function* () {
	yield* Admin;
	const flags = yield* Flags;
	const store = yield* FlagOverrideStore;
	const overrides = yield* store.listActiveOverrides();
	const items = yield* Effect.forEach(DECLARED_FLAGS, (flag) =>
		Effect.gen(function* () {
			const effective = yield* flags
				.getBoolean(flag.key, flag.defaultValue)
				.pipe(provideRequestFlags);
			const node = toFlagState({
				key: flag.key,
				defaultValue: flag.defaultValue,
				effective,
				overridden: overrides.has(flag.key),
			});
			return {cursor: node.id, node};
		}),
	);
	return {
		items,
		pagination: {hasNext: false, hasPrevious: false},
	} satisfies ConnectionResult<FlagStateEntity>;
});

export const lists = {
	"flags.state": Fate.list(
		{
			args: FlagsStateArgs,
			type: FlagStateView,
			error: Schema.Union([Denied]),
		},
		Effect.fn("flags.state")(function* () {
			if (!(yield* adminConsoleOn)) {
				return yield* Effect.fail(new Denied({message: "Bu işlem şu an kapalı."}));
			}
			return yield* requireAdmin(flagsStateGated());
		}),
	),
};
