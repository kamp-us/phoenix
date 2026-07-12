/**
 * `Actor` — who is making a request, the root input every capability check
 * dispatches on (ADR 0107 §6). Three-armed: `Unauthenticated`, an authenticated
 * `Human`, and an authenticated `Agent` carrying its human `root`.
 *
 * The Human/Agent split is the dormant agent seam: v1 is humans-only, but every
 * discharge verb already routes the `Agent` arm through the {@link AgentAuthority}
 * port, so v1.1's "an agent's authority ⊆ its human root" attenuation is a Layer
 * swap, never an edit to this mechanism. Vocab-free: bare ids, no kamp.us noun —
 * adapters (`features/kunye`) build an `Actor` from the pasaport session.
 */

export interface Human {
	readonly _tag: "Human";
	readonly id: string;
}

export interface Agent {
	readonly _tag: "Agent";
	readonly id: string;
	readonly root: string;
}

export type Principal = Human | Agent;

export interface Unauthenticated {
	readonly _tag: "Unauthenticated";
}

export interface Authenticated {
	readonly _tag: "Authenticated";
	readonly principal: Principal;
}

export type Actor = Unauthenticated | Authenticated;

export const unauthenticated: Unauthenticated = {_tag: "Unauthenticated"};

export const human = (id: string): Authenticated => ({
	_tag: "Authenticated",
	principal: {_tag: "Human", id},
});

export const agent = (id: string, root: string): Authenticated => ({
	_tag: "Authenticated",
	principal: {_tag: "Agent", id, root},
});

/**
 * Exhaustively dispatch on an {@link Actor}. The single match site every
 * discharge verb routes through, so "handle every actor arm" is structural —
 * adding a fourth arm becomes a compile error at this one function, not a
 * silent fall-through at each callsite.
 */
export const matchActor = <A>(
	actor: Actor,
	handlers: {
		readonly onUnauthenticated: () => A;
		readonly onHuman: (human: Human) => A;
		readonly onAgent: (agent: Agent) => A;
	},
): A => {
	if (actor._tag === "Unauthenticated") return handlers.onUnauthenticated();
	const principal = actor.principal;
	return principal._tag === "Human" ? handlers.onHuman(principal) : handlers.onAgent(principal);
};
