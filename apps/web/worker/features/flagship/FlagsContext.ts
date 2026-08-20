/**
 * `FlagsContext` — the per-request flag evaluation context, supplied per request
 * alongside `Auth` (ADR 0029) rather than captured at isolate scope.
 *
 * The domain shape is deliberately NOT alchemy's `Flagship.EvaluationContext` —
 * `toEvaluationContext` maps it at the boundary so the provider's wire shape never
 * leaks into the domain surface. See [.patterns/feature-flags-targeting.md](../../../../../.patterns/feature-flags-targeting.md).
 */
import {CurrentUser} from "@kampus/fate-effect";
import type {Flagship} from "alchemy/Cloudflare";
import {Context, Effect} from "effect";
import {AppConfig} from "../../config.ts";
import {type FlagOverrides, parseOverrideCookie} from "./dev-override.ts";

export interface FlagsContextValue {
	/** Stable identity for per-user bucketing; absent for an anonymous request. */
	readonly userId?: string;
	readonly roles?: readonly string[];
	/** Sourced from `ENVIRONMENT` by {@link makeRequestFlagsContext}, never hand-passed (#512). */
	readonly environment?: string;
	/**
	 * Per-browser local flag overrides (#622). Populated ONLY when the request may honor
	 * them — `development`, or an admin request (#2741); every other request leaves it
	 * `undefined` (fail-closed), so an attacker-supplied cookie is a no-op on a deployed
	 * stage. Not a targeting attribute, so `toEvaluationContext` ignores it.
	 */
	readonly overrides?: FlagOverrides;
}

export class FlagsContext extends Context.Service<FlagsContext, FlagsContextValue>()(
	"@kampus/FlagsContext",
) {}

/**
 * The request's raw `Cookie` header plus the per-request override-authorization verdict
 * (#2741), carried as a service because the `/fate` route edge has the raw request and a
 * resolver deep in the tree does not. Fulfilled per request in `fate/route.ts` and declared
 * to `FateServer.layer`, so — like `CurrentActor` — it is excluded from build-time `R`.
 *
 * Transport only: {@link makeRequestFlagsContext} is the single site that decides whether
 * to parse the cookie.
 */
export class RequestFlagOverrides extends Context.Service<
	RequestFlagOverrides,
	{readonly cookieHeader: string | null; readonly overridesAllowed: boolean}
>()("@kampus/RequestFlagOverrides") {}

export const anonymousFlagsContext: FlagsContextValue = {};

/**
 * `environment` always comes from the deploy stage (ADR 0057), never from a call-site
 * (#512). Pass `anonymousFlagsContext` as `identity` for an unauthenticated request.
 *
 * Fail-closed gate: `ENVIRONMENT` defaults to `"production"` and `overridesAllowed` to
 * `false`, so a deployed non-admin request never reads the override cookie and an
 * attacker-supplied `phoenix_flag_overrides` can never flip a flag in prod.
 */
export const makeRequestFlagsContext = (
	identity: FlagsContextValue,
	cookieHeader?: string | null,
	overridesAllowed = false,
) =>
	Effect.gen(function* () {
		// `orDie`: a `ConfigError` here means a malformed env, unrecoverable.
		const {environment} = yield* AppConfig.pipe(Effect.orDie);
		// THE GATE: overrides exist only under `development` (#622) or for an authorized
		// admin-on-prod request (#2741). Any other request drops the cookie entirely.
		const honorOverrides = environment === "development" || overridesAllowed;
		const parsed = honorOverrides ? parseOverrideCookie(cookieHeader) : undefined;
		const overrides = parsed && Object.keys(parsed).length > 0 ? parsed : undefined;
		return {
			...identity,
			environment,
			...(overrides ? {overrides} : {}),
		} satisfies FlagsContextValue;
	});

/**
 * THE ONE place flag bucketing is wired for fate resolvers, so a change to what the
 * context carries is an edit here, not at every gating site. Swaps the `FlagsContext`
 * requirement for `CurrentUser`, which `FateServer.layer` excludes from the layer `R`.
 */
export const provideRequestFlags = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, FlagsContext> | CurrentUser | RequestFlagOverrides> =>
	Effect.gen(function* () {
		const {user} = yield* CurrentUser;
		// A thin pass-through — the gate itself lives in `makeRequestFlagsContext`.
		const {cookieHeader, overridesAllowed} = yield* RequestFlagOverrides;
		const context = yield* makeRequestFlagsContext(
			user ? {userId: user.id} : anonymousFlagsContext,
			cookieHeader,
			overridesAllowed,
		);
		return yield* effect.pipe(Effect.provideService(FlagsContext, context));
	});

/**
 * The leading+trailing pipes let a `contains "|internal|"` rule match a whole role
 * without a substring false-positive (`"|internal|"` ⊄ `"|internal-admin|"`).
 */
const ROLE_DELIMITER = "|";

export const encodeRoles = (roles: readonly string[]): string =>
	roles.length === 0 ? "" : `${ROLE_DELIMITER}${roles.join(ROLE_DELIMITER)}${ROLE_DELIMITER}`;

/**
 * Kept at this one boundary so the alchemy/cf type stays out of the `Flags` public
 * surface. The wire shape admits no arrays, so a role list is flattened to a single
 * delimited string targeted with `contains`.
 */
export function toEvaluationContext(
	context: FlagsContextValue,
): Flagship.EvaluationContext | undefined {
	const wire: Record<string, string> = {};
	if (context.userId !== undefined) wire.targetingKey = context.userId;
	if (context.roles !== undefined && context.roles.length > 0)
		wire.roles = encodeRoles(context.roles);
	if (context.environment !== undefined) wire.environment = context.environment;
	// An empty context carries no targeting signal, so the provider buckets anonymously.
	return Object.keys(wire).length === 0 ? undefined : wire;
}
