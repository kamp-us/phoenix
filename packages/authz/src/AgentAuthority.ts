/**
 * `AgentAuthority` — the agent-attenuation port (ADR 0107 §6), **seamed but
 * dormant in v1**. Agent attenuation ("an agent's authority ⊆ its human root")
 * is a *read/combine* seam: a discharge verb *reads* the agent's human-root
 * standing (the root must independently pass the underlying check) and hands the
 * agent down to this port, which *combines* — deciding whether the agent's
 * attenuated authority {@link admits} the right.
 *
 * This package declares **only the port** — no policy. v1's Layer
 * (`AgentAuthorityV1` in `features/kunye`) is fail-closed (`admits` ⇒ `false`),
 * so v1 grants no agent any authority. The framework's completeness litmus is
 * that v1.1's real attenuation policy is **this one Layer swapped**, with no
 * edit to `packages/authz`.
 */
import {Context, type Effect} from "effect";
import type {Agent} from "./Actor.ts";

/** The combine input: which agent, asking for which capability tag. */
export interface AgentAuthorityRequest {
	readonly agent: Agent;
	readonly capability: string;
}

/**
 * The agent-attenuation decision port. `admits` is consulted **after** the
 * discharge verb has confirmed the agent's human root would itself pass — so a
 * `true` here means "the root passes *and* the agent's attenuated authority
 * admits it". v1's Layer returns `false` (fail-closed, humans-only).
 */
export class AgentAuthority extends Context.Service<
	AgentAuthority,
	{
		readonly admits: (request: AgentAuthorityRequest) => Effect.Effect<boolean>;
	}
>()("authz/AgentAuthority") {}
