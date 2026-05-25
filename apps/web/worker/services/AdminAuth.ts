/**
 * AdminAuth service — gates admin Hono routes (`/api/admin/*`) the same way
 * `Auth` gates the fate request runtime.
 *
 * Initial implementation derives `{allowed}` from `env.ENVIRONMENT === "development"`,
 * matching today's per-route `if (env.ENVIRONMENT !== "development") return 403`
 * guard. Future hardening (Pasaport karma threshold, signed admin tokens, etc.)
 * lands inside the layer with no call-site changes.
 *
 * See ADR 0012 (admin parallel services) for the two-runtime split rationale
 * and `.patterns/effect-layer-composition.md#multiple-runtimes--graphql--admin`
 * for the wiring shape.
 */
import {Context, Data, Effect, Layer} from "effect";
import {CloudflareEnv} from "./CloudflareEnv.ts";

/**
 * Raised when an admin operation is attempted outside an allowed context.
 * Maps to a 403 at the Hono edge.
 */
export class AdminForbidden extends Data.TaggedError("@phoenix/AdminAuth/Forbidden")<{
	readonly reason: string;
}> {}

/**
 * Per-request admin auth state. `allowed` reflects whether the current
 * environment is permitted to invoke admin operations.
 */
export class AdminAuth extends Context.Service<
	AdminAuth,
	{
		readonly allowed: boolean;
	}
>()("@phoenix/AdminAuth") {
	/**
	 * Require admin permission — fails with `AdminForbidden` otherwise. Mirrors
	 * `Auth.required` in shape so admin handlers read the same way fate request
	 * handlers do.
	 *
	 * @example
	 *   app.post("/api/admin/sozluk/clear", (c) =>
	 *     runtime.runPromise(Effect.gen(function*() {
	 *       yield* AdminAuth.required;
	 *       return yield* (yield* SozlukAdmin).clearAllTerms(...);
	 *     })),
	 *   );
	 */
	static readonly required: Effect.Effect<void, AdminForbidden, AdminAuth> = Effect.gen(
		function* () {
			const auth = yield* AdminAuth;
			if (!auth.allowed) {
				return yield* new AdminForbidden({reason: "admin operations disabled in this environment"});
			}
		},
	);
}

/**
 * Live layer — derives `allowed` from the worker environment. In production
 * the admin routes are inert. Future versions can yield richer signals
 * (Pasaport karma, signed tokens) without changing the call sites.
 */
export const AdminAuthLive = Layer.effect(AdminAuth)(
	Effect.gen(function* () {
		const env = yield* CloudflareEnv;
		return {
			allowed: env.ENVIRONMENT === "development",
		};
	}),
);
