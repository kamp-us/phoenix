/**
 * `CurrentActorLive` — the adapter that realizes the authz {@link CurrentActor}
 * port from the per-request pasaport session (ADR 0107 §5/§7). It derives the
 * {@link Actor} from fate's {@link CurrentUser} and hands it to the app through
 * the generic fate-effect provision seam (#1230), never a worker-level `Layer`:
 * the actor is per-request (it depends on the request's session), so it belongs
 * in `FateRequestContext.requestServices`, fulfilled at the `/fate` route edge.
 *
 * **v1 is humans-only:** the derivation yields only `Unauthenticated` (anonymous
 * traffic) or `Human` (a signed-in account), never `Agent`. The agent arm is the
 * dormant seam — there is no agent identity on the session in v1, so an
 * authenticated request is always a `Human`.
 */
import {type Actor, CurrentActor, human, unauthenticated} from "@kampus/authz";
import type {CurrentUserInfo} from "@kampus/fate-effect";
import {Context} from "effect";

/**
 * Derive the request's {@link Actor} from the session user: `undefined` (anonymous)
 * → `Unauthenticated`, otherwise the signed-in account → `Human`. Never `Agent` (v1).
 */
export const currentActorOf = (user: CurrentUserInfo | undefined): Actor =>
	user === undefined ? unauthenticated : human(user.id);

/**
 * The per-request {@link CurrentActor} value, ready to drop into
 * `FateRequestContext.requestServices` (`Context.make(CurrentActor, …)`). The
 * `/fate` route edge calls this with the validated session user; the seam
 * provides it innermost so capability checks `yield* CurrentActor` resolve it.
 */
export const currentActorContext = (
	user: CurrentUserInfo | undefined,
): Context.Context<CurrentActor> => Context.make(CurrentActor, {actor: currentActorOf(user)});
