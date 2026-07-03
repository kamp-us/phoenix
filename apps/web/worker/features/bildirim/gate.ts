/**
 * The bildirim dark-ship gate (#1694, ADR 0083): every bildirim resolver runs
 * only when the `phoenix-bildirim` flag is on for this request. Off (the
 * default, and any Flagship outage — safe read default `false`) ⇒ the invisible
 * {@link Denied}, so nothing user-visible changes and nothing leaks even on a
 * direct wire call — the `funnel.summary` shape. One gate all sibling emitters'
 * surfaces reuse; no per-child flags.
 */
import {Effect} from "effect";
import {PHOENIX_BILDIRIM} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Denied} from "../kunye/errors.ts";

const bildirimOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_BILDIRIM, false).pipe(provideRequestFlags);
});

export const requireBildirimOn = Effect.gen(function* () {
	if (!(yield* bildirimOn)) {
		return yield* Effect.fail(new Denied({message: "Bildirimler şu an kapalı."}));
	}
});
