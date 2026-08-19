/**
 * The fail-closed v1 fill of the `AgentAuthority` port (ADR 0107 §6): v1 is humans-only,
 * so `admits` denies every agent even when their human root would pass. v1.1's real
 * attenuation is THIS ONE LAYER swapped, with no edit to `packages/authz` — so keep it
 * the sole implementation point and do not grow agent policy here.
 */
import {AgentAuthority} from "@kampus/authz";
import {Effect, Layer} from "effect";

export const AgentAuthorityV1: Layer.Layer<AgentAuthority> = Layer.succeed(AgentAuthority)(
	AgentAuthority.of({
		admits: () => Effect.succeed(false),
	}),
);
