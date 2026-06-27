/**
 * `AgentAuthorityV1` — the fail-closed v1 fill of the `AgentAuthority` port
 * (ADR 0107 §6). v1 is humans-only, so `admits` denies every agent: the
 * capability discharge verbs route their `Agent` arm through this port (a `Human`
 * passes directly, unattenuated), so a `false` here grants agents zero standing
 * even when their human root would itself pass.
 *
 * The whole point of the seam is that v1.1's real attenuation (agent authority ⊆
 * its human root) is **this one Layer swapped**, with no edit to `packages/authz`
 * — the framework's completeness litmus. Keep this Layer the sole implementation
 * point of the port; do not grow agent policy here.
 */
import {AgentAuthority} from "@kampus/authz";
import {Effect, Layer} from "effect";

export const AgentAuthorityV1: Layer.Layer<AgentAuthority> = Layer.succeed(AgentAuthority)(
	AgentAuthority.of({
		admits: () => Effect.succeed(false),
	}),
);
