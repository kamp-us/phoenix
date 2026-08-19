/**
 * Bildirim mute-suppression (#3238) — the notification analogue of the content
 * read-mask. See ADR 0188 for why v1 mute suppresses notifications, not just reads.
 *
 * Generation-time, NOT read-time: the anti-hype vote aggregate stores `actorId: null`,
 * so the interacting member's identity survives only at emit time and a read-time
 * filter on `notification.actor_id` could never suppress an aggregated vote.
 */
import type {CurrentUser} from "@kampus/fate-effect";
import type {RuntimeContext} from "alchemy";
import {Effect} from "effect";
import {MEMBER_MUTE} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags, type RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import {Mute} from "../mute/Mute.ts";

/**
 * A null actor is a system moment with nothing to suppress, resolved before any flag
 * or DB read. Gated behind the default-off `member-mute` flag, whose safe default
 * `false` covers both an unflipped flag and a Flagship outage. The muted set is read
 * through `Mute.readMutedIds(recipientId)` — the same source the content read-mask
 * uses, never a second one.
 */
export const bildirimMutedBy = (
	recipientId: string,
	actorId: string | null | undefined,
): Effect.Effect<
	boolean,
	never,
	Flags | RuntimeContext | RequestFlagOverrides | CurrentUser | Mute
> =>
	Effect.gen(function* () {
		if (!actorId) return false;
		const flags = yield* Flags;
		const on = yield* flags.getBoolean(MEMBER_MUTE, false).pipe(provideRequestFlags);
		if (!on) return false;
		const mute = yield* Mute;
		const muted = yield* mute.readMutedIds(recipientId);
		return muted.has(actorId);
	});
