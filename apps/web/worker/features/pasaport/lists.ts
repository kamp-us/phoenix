/**
 * The admin failing-address roll-up. Both gates are enforced HERE, because the service
 * read is unconditional: the dark-ship flag and `requireAdmin` (ADR 0107). Both denials
 * are the same invisible `Denied`, so a non-admin cannot tell them apart.
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

/** Safe-default `false` — the flag reads dark when it cannot be resolved. */
const emailDeliveryAdminOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_EMAIL_DELIVERY_ADMIN, false).pipe(provideRequestFlags);
});

// `yield* Admin` demands the proof in R, so this read is unreachable without a discharged
// grant — a compile-time gate, not an `if`.
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
