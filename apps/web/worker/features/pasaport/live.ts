/**
 * Pasaport live-publish targets — the ONE place that answers "what does a
 * pasaport mutation publish to?" Binds the entity's wire `__typename` (read off
 * the view's `typeName`, never an inline `"User"` literal) to the entity-field
 * topic it participates in, so a resolver names the fan-out target instead of
 * restating the magic-string seam (#1127), mirroring `pano/live.ts` /
 * `sozluk/live.ts`.
 *
 * The only pasaport live seam today is the çaylak→yazar tier flip (#1886): a
 * committed `promoteToYazar` must publish a `User` entity update so an open
 * profile view reconciles the new `tier` over `/fate/live` without a manual
 * reload. `User` is the entity the app-lifetime global live pin subscribes
 * (`.patterns/fate-live-consistency.md#global-pin`, ADR 0094 — `User.id === CurrentUser.id`),
 * so a `live.update("User", id, …)` reaches every open profile/User view of the
 * promoted member.
 *
 * The bound call forwards verbatim to `WorkerLivePublisher.update`, whose error
 * channel is `never` (`.patterns/fate-effect-server.md`): a failed publish can
 * never fail the committed tier flip.
 */

import type {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {UserView} from "./views.ts";

const USER = UserView.typeName;

/** Bind pasaport's publish targets to the per-request publisher. */
export const pasaportLive = (live: WorkerLivePublisher) => ({
	user: {
		update: (id: string | number, options?: {changed?: ReadonlyArray<string>; data?: unknown}) =>
			live.update(USER, id, options),
	},
});
