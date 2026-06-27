/**
 * `AgentAuthority` — the agent-attenuation port (ADR 0107 §6), seamed but
 * dormant in v1. A discharge verb first confirms the agent's human root would
 * itself pass, then hands the agent to {@link admits} to decide whether the
 * agent's attenuated authority covers the right. The package declares only the
 * port; v1's Layer (`features/kunye`) is fail-closed (`admits` ⇒ `false`,
 * humans-only). The completeness litmus: v1.1's real policy is this one Layer
 * swapped, with no edit to `packages/authz`.
 */
import {Context, type Effect} from "effect";
import type {Agent} from "./Actor.ts";

/** Which agent, asking for which capability tag. */
export interface AgentAuthorityRequest {
	readonly agent: Agent;
	readonly capability: string;
}

export class AgentAuthority extends Context.Service<
	AgentAuthority,
	{
		readonly admits: (request: AgentAuthorityRequest) => Effect.Effect<boolean>;
	}
>()("authz/AgentAuthority") {}
