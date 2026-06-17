/**
 * `FlagsContext` — the per-request flag evaluation context (epic #488, #508).
 *
 * Carries the request's identity for stable per-user bucketing, supplied per
 * request alongside `Auth` (ADR 0029) rather than captured at isolate scope —
 * the same identity an `Auth` session yields, lifted into flag evaluation so a
 * given user lands in a stable bucket across requests. Targeting/percentage
 * rules that consume it land in #511; this child supplies the seam.
 *
 * The domain shape (`userId`) is deliberately NOT alchemy's
 * `FlagshipEvaluationContext` — `toEvaluationContext` maps it at the boundary so
 * the provider's wire shape never leaks into the domain surface (the clean
 * OpenFeature seam, #506).
 */
import type {FlagshipEvaluationContext} from "alchemy/Cloudflare";
import {Context} from "effect";

/** The domain-facing per-request evaluation context. */
export interface FlagsContextValue {
	/** Stable identity for per-user bucketing; absent for an anonymous request. */
	readonly userId?: string;
	/**
	 * Roles the request's identity holds (e.g. `["internal", "beta"]`). Feeds
	 * attribute targeting via the `in`/`not_in` operators against a sanctioned
	 * role; absent or empty for a request with no roles. The targeting taxonomy
	 * is in [.patterns/feature-flags-targeting.md](../../../../../.patterns/feature-flags-targeting.md).
	 */
	readonly roles?: readonly string[];
	/**
	 * Deployment environment the request runs in (e.g. `"production"`,
	 * `"preview"`). Feeds environment-scoped targeting rules; #512 owns wiring
	 * the actual per-app-stage value, this child only carries the attribute.
	 */
	readonly environment?: string;
}

export class FlagsContext extends Context.Service<FlagsContext, FlagsContextValue>()(
	"@kampus/FlagsContext",
) {}

/** The anonymous request context — no identity to bucket on. */
export const anonymousFlagsContext: FlagsContextValue = {};

/**
 * Delimiter framing each role in the flattened `roles` wire attribute. The
 * leading+trailing pipes let a `contains "|internal|"` rule match a whole role
 * without a substring false-positive (`"|internal|"` ⊄ `"|internal-admin|"`).
 */
const ROLE_DELIMITER = "|";

/** Frame a role list as a single `contains`-targetable wire string. */
export const encodeRoles = (roles: readonly string[]): string =>
	roles.length === 0 ? "" : `${ROLE_DELIMITER}${roles.join(ROLE_DELIMITER)}${ROLE_DELIMITER}`;

/**
 * Map the domain context to the provider's evaluation-context wire shape. Kept
 * here, at the one boundary, so the alchemy/cf type stays out of the `Flags`
 * public surface — only `FlagsLive` calls it.
 *
 * `userId → targetingKey` is the consistent-hash bucketing key: the mapping is
 * deterministic, so a given `userId` always yields the same `targetingKey` and
 * thus the same percentage-rollout bucket across requests (no flicker). Role and
 * environment attributes feed attribute-targeting rules; the wire shape is a flat
 * `Record<string, string | number | boolean>` (no arrays), so a role list is
 * flattened to a single delimited `roles` string targeted with `contains`.
 */
export function toEvaluationContext(
	context: FlagsContextValue,
): FlagshipEvaluationContext | undefined {
	const wire: Record<string, string> = {};
	if (context.userId !== undefined) wire.targetingKey = context.userId;
	if (context.roles !== undefined && context.roles.length > 0)
		wire.roles = encodeRoles(context.roles);
	if (context.environment !== undefined) wire.environment = context.environment;
	// An empty context carries no targeting signal — match the prior `userId`-only
	// contract and return undefined so the provider buckets anonymously.
	return Object.keys(wire).length === 0 ? undefined : wire;
}
