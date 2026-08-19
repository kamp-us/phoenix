/**
 * `CurrentActorLive` — realizes the authz {@link CurrentActor} port from the
 * per-request pasaport session (ADR 0107 §5/§7). Provided through fate-effect's
 * per-request seam, never a worker-level `Layer`, because the actor depends on the
 * request's session.
 *
 * v1 is humans-only: `Unauthenticated` or `Human`, never `Agent`. There is no agent
 * identity on the session yet, so the agent arm is a dormant seam.
 */
import {type Actor, CurrentActor, human, unauthenticated} from "@kampus/authz";
import type {CurrentUserInfo} from "@kampus/fate-effect";
import {Context} from "effect";

export const currentActorOf = (user: CurrentUserInfo | undefined): Actor =>
	user === undefined ? unauthenticated : human(user.id);

/**
 * The per-request {@link CurrentActor} value for
 * `FateRequestContext.requestServices`, built at the `/fate` route edge.
 */
export const currentActorContext = (
	user: CurrentUserInfo | undefined,
): Context.Context<CurrentActor> => Context.make(CurrentActor, {actor: currentActorOf(user)});
