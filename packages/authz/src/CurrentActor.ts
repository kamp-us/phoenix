/**
 * `CurrentActor` — the per-request actor port (ADR 0107 §5). A capability check
 * binds it once (`const {actor} = yield* CurrentActor`) and dispatches; it
 * names no kamp.us noun. The adapter (`features/kunye`'s `CurrentActorLive`,
 * fed by the fate-effect per-request provision seam, ADR 0107 §7) builds the
 * {@link Actor} from the pasaport session.
 */
import {Context} from "effect";
import type {Actor} from "./Actor.ts";

/** The actor behind the current request. */
export class CurrentActor extends Context.Service<
	CurrentActor,
	{
		readonly actor: Actor;
	}
>()("authz/CurrentActor") {}
