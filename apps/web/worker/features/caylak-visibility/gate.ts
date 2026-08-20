/**
 * The çaylak-visibility dark-ship gate (#6422, epic #4306, ADR 0083): every resolver
 * in this feature runs only when `phoenix-caylak-visibility` is on for this request.
 * Safe default `false` — an unflipped flag and a Flagship outage read the same.
 *
 * The write half fails the invisible {@link Denied} (the `requireBildirimOn` shape),
 * so the mutations are unreachable with the flag off even on a direct wire call. The
 * read half does NOT fail: {@link caylakVisibilityOn} is the raw read the query
 * short-circuits on, resolving "not opted in" with no D1 query, so a signed-in client
 * gets a well-formed answer from a dark feature instead of an error rail.
 */
import {Effect} from "effect";
import {PHOENIX_CAYLAK_VISIBILITY} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Denied} from "../kunye/errors.ts";

export const caylakVisibilityOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_CAYLAK_VISIBILITY, false).pipe(provideRequestFlags);
});

export const requireCaylakVisibilityOn = Effect.gen(function* () {
	if (!(yield* caylakVisibilityOn)) {
		return yield* Effect.fail(new Denied({message: "Bu ayar şu an kapalı."}));
	}
});
