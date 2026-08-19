/**
 * The bildirim dark-ship gate (#1694, ADR 0083). Off — the default, and any Flagship
 * outage — yields the invisible {@link Denied}, so nothing leaks even on a direct wire
 * call. One gate for every sibling emitter's surface; no per-child flags.
 *
 * RELEASE SEQUENCING (#3641, founder ruling on #2562): `phoenix-bildirim` may not
 * graduate unless `notifyReportFiled`'s per-reporter/window page coalescing is live.
 * That aggregation is the abuse control on the moderator pager — without it one
 * karma-less account pages the whole team once per report per moderator, un-throttled.
 * A karma floor was rejected as the gate (#2562/#3309), and the per-actor rate limiter
 * (#2561) is a companion, not a substitute.
 */
import {Effect} from "effect";
import {PHOENIX_BILDIRIM} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Denied} from "../kunye/errors.ts";

// Emitters gate their WRITES on this — a silent skip, never the resolver gate's
// `Denied`. Safe default `false`.
export const bildirimOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_BILDIRIM, false).pipe(provideRequestFlags);
});

export const requireBildirimOn = Effect.gen(function* () {
	if (!(yield* bildirimOn)) {
		return yield* Effect.fail(new Denied({message: "Bildirimler şu an kapalı."}));
	}
});
