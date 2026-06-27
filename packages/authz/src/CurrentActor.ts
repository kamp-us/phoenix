/**
 * `CurrentActor` — the per-request actor port (ADR 0107 §5). A capability check
 * binds it once and dispatches. The adapter (`features/kunye`, fed by the
 * fate-effect provision seam, ADR 0107 §7) builds the {@link Actor} from the
 * pasaport session.
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
