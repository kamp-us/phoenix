/**
 * Bildirim mute-suppression (#3238) — the notification analogue of the content
 * read-mask (`../mute/read-mask.ts`). ADR 0188 ruled v1 mute (sustur) suppresses the
 * bildirim a muted member's interactions would raise to the muter, not merely a
 * content read-mask; this is the seam the interaction emitters consult before they
 * record.
 *
 * Generation-time, not read-time: the anti-hype vote aggregate stores `actorId: null`
 * (see `vote-emitters.ts` / `rite-emitters.ts`), so the interacting member's identity
 * survives ONLY at emit time — a read-time filter on `notification.actor_id` could
 * never suppress an aggregated vote. The seam is therefore a per-emit predicate keyed
 * on (recipient = the muter, actor = the interacting member): suppress iff the
 * recipient has muted the actor.
 */
import type {CurrentUser} from "@kampus/fate-effect";
import type {RuntimeContext} from "alchemy";
import {Effect} from "effect";
import {MEMBER_MUTE} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags, type RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import {Mute} from "../mute/Mute.ts";

/**
 * True iff a bildirim to `recipientId` about `actorId`'s interaction must be
 * suppressed — the recipient (muter) has muted the actor. A null/absent actor is a
 * system moment with no interacting member (a `terfi`/`caylak-pending` emit), so
 * nothing to suppress, resolved before any flag or DB read. Gated behind the
 * default-off `member-mute` flag the read-mask also uses (safe default `false`: an
 * unflipped default or a Flagship outage both read off) ⇒ `false` ⇒ unchanged
 * delivery. Viewer-scoped through `Mute.readMutedIds(recipientId)` — the muter IS the
 * recipient — the same set the content read-mask reads from, no divergent muted-id
 * source.
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
