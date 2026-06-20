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
import {CurrentUser} from "@kampus/fate-effect";
import type {FlagshipEvaluationContext} from "alchemy/Cloudflare";
import {Context, Effect} from "effect";
import {AppConfig} from "../../config.ts";

/** The domain-facing per-request evaluation context. */
export interface FlagsContextValue {
	/** Stable identity for per-user bucketing; absent for an anonymous request. */
	readonly userId?: string;
	/**
	 * Roles the request's identity holds (e.g. `["internal", "beta"]`). Flattened
	 * by `encodeRoles` into a pipe-framed wire string (`["internal"]` →
	 * `"|internal|"`) and targeted with the `contains` operator against a framed
	 * needle (`"|internal|"`) — see the `demoTargetingFlag` rule; absent or empty
	 * for a request with no roles. The targeting taxonomy is in
	 * [.patterns/feature-flags-targeting.md](../../../../../.patterns/feature-flags-targeting.md).
	 */
	readonly roles?: readonly string[];
	/**
	 * Deployment environment the request runs in (e.g. `"production"`,
	 * `"development"`). Feeds environment-scoped targeting rules so one flag can
	 * resolve differently per stage with no code change at the call-site. Sourced
	 * from the `ENVIRONMENT` config var — the per-app deploy stage (ADR 0057) — by
	 * {@link makeRequestFlagsContext}, never hand-passed (#512).
	 */
	readonly environment?: string;
}

export class FlagsContext extends Context.Service<FlagsContext, FlagsContextValue>()(
	"@kampus/FlagsContext",
) {}

/** The anonymous request context — no identity to bucket on. */
export const anonymousFlagsContext: FlagsContextValue = {};

/**
 * Build the per-request {@link FlagsContextValue}, sourcing the `environment`
 * attribute from the deploy stage rather than letting a call-site hand-pass it
 * (#512). The environment comes from `ENVIRONMENT` via `yield* AppConfig` — the
 * same per-app-stage signal (`alchemy deploy --stage <name>`, ADR 0057) the
 * health route reads — resolved off the `ConfigProvider` alchemy auto-wires at
 * worker scope. So a flag with an environment-targeting rule resolves per stage
 * (development vs production) with no code change at any call-site.
 *
 * `identity` carries the request's session-derived attributes (user id for
 * bucketing, roles for attribute targeting); pass `anonymousFlagsContext` for an
 * unauthenticated request. The environment is always populated from the stage —
 * it is a deploy-time fact about the request, not a per-user one.
 */
export const makeRequestFlagsContext = (identity: FlagsContextValue) =>
	Effect.gen(function* () {
		// `orDie`: a `ConfigError` (value outside the two literals) is a malformed
		// env, unrecoverable — match the health route's read of the same var.
		const {environment} = yield* AppConfig.pipe(Effect.orDie);
		return {...identity, environment} satisfies FlagsContextValue;
	});

/**
 * Provide the per-request {@link FlagsContext} to a flag-reading effect, sourcing
 * the identity from the request's `CurrentUser` (the same per-request session the
 * fate edge provides, ADR 0029) and the environment from the deploy stage. THE
 * ONE place flag bucketing is wired for fate resolvers: a flag-gated resolver
 * reads `flags.getBoolean(key, default)` directly and discharges the context with
 * a single `.pipe(provideRequestFlags)`, so a change to what the context carries
 * is an edit here, not at every gating site. Swaps the `FlagsContext` requirement
 * for `CurrentUser`, which gated resolvers already hold and which `FateServer.layer`
 * excludes from the layer R — so it never surfaces as a build-time requirement.
 */
export const provideRequestFlags = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, FlagsContext> | CurrentUser> =>
	Effect.gen(function* () {
		const {user} = yield* CurrentUser;
		const context = yield* makeRequestFlagsContext(
			user ? {userId: user.id} : anonymousFlagsContext,
		);
		return yield* effect.pipe(Effect.provideService(FlagsContext, context));
	});

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
