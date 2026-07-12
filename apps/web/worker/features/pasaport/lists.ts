/**
 * Pasaport root list resolvers — `emailDelivery.failing`, the admin failing-address
 * roll-up (Child #2692, email-bounce epic #2687). `Fate.list` def + `Effect.fn` pair
 * (`.patterns/fate-effect-operations.md`); the list is delivered inline (no source
 * `connection`), so the resolver builds the wire shape itself.
 *
 * Two gates, both enforced HERE (the service read is unconditional), mirroring
 * `divan/lists.ts`:
 *   1. The `PHOENIX_EMAIL_DELIVERY_ADMIN` dark-ship flag (default-off, ADR 0083). Off ⇒
 *      the invisible `Denied` (the ban-surface stance), so the roll-up never leaks before
 *      release.
 *   2. `requireAdmin` (ADR 0107) — `yield* Admin` makes the read unreachable without the
 *      discharged grant, so a non-admin gets the SAME invisible `Denied`.
 *
 * A single-page private read (no live view, no cursor pagination), so the
 * `ConnectionResult` is `hasNext: false`, mirroring `divan.roster`.
 */
import {Fate} from "@kampus/fate-effect";
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {PHOENIX_EMAIL_DELIVERY_ADMIN} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Admin, requireAdmin} from "../kunye/admin.ts";
import {Denied} from "../kunye/errors.ts";
import {Pasaport} from "./Pasaport.ts";
import {toFailingAddress} from "./shapers.ts";
import type {FailingAddressEntity} from "./views.ts";
import {FailingAddressView} from "./views.ts";

const FailingArgs = Schema.Struct({});

/** Is the #2692 admin email-delivery flag on for this request? Safe-default `false` (dark). */
const emailDeliveryAdminOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_EMAIL_DELIVERY_ADMIN, false).pipe(provideRequestFlags);
});

// The post-gate roll-up read — `Admin`-gated in R (`requireAdmin` provides the grant).
// `yield* Admin` requires the proof; the roll-up is unreachable without a discharged grant.
const failingGated = Effect.fn("emailDelivery.failingGated")(function* () {
	yield* Admin;
	const pasaport = yield* Pasaport;
	const failing = yield* pasaport.listFailingAddresses();
	return {
		items: failing.map((row) => {
			const node = toFailingAddress(row);
			return {cursor: node.id, node};
		}),
		pagination: {hasNext: false, hasPrevious: false},
	} satisfies ConnectionResult<FailingAddressEntity>;
});

export const lists = {
	"emailDelivery.failing": Fate.list(
		{
			args: FailingArgs,
			type: FailingAddressView,
			error: Schema.Union([Denied]),
		},
		Effect.fn("emailDelivery.failing")(function* () {
			if (!(yield* emailDeliveryAdminOn)) {
				return yield* Effect.fail(new Denied({message: "Bu işlem şu an kapalı."}));
			}
			return yield* requireAdmin(failingGated());
		}),
	),
};
