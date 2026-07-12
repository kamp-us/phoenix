/**
 * The `phoenix-admin-console` dark-ship gate, shared by the admin flag-state view
 * (`lists.ts`) and the runtime-flip mutation (`mutations.ts`) so the flag key is read once.
 *
 * Safe-default `false` (dark), the `userBanOn` / `emailDeliveryAdminOn` idiom: with the flag
 * off (default / Flagship outage) both surfaces fail the invisible `Denied` exactly like a
 * non-admin call, so the console's worker half stays dark until a human flips it at release
 * (ADR 0083). The whole surface pairs this with `requireAdmin` (ADR 0107): two gates, both
 * enforced at the resolver.
 */
import {Effect} from "effect";
import {PHOENIX_ADMIN_CONSOLE} from "../../../src/flags/keys.ts";
import {Flags} from "./Flags.ts";
import {provideRequestFlags} from "./FlagsContext.ts";

/** Is the #2711 admin-console dark-ship flag on for this request? Safe-default `false` (dark). */
export const adminConsoleOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_ADMIN_CONSOLE, false).pipe(provideRequestFlags);
});
