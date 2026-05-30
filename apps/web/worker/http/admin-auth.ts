/**
 * AdminAuth service — gates the typed-JSON admin routes (`/api/admin/*`) the
 * same way `Auth` gates the fate request runtime.
 *
 * `allowed` is derived from `env.ENVIRONMENT === "development"` via the
 * {@link adminAllowed} predicate. The dev-only admin surfaces fail-closed:
 * open only when `ENVIRONMENT === "development"`. Future hardening (Pasaport
 * karma threshold, signed admin tokens, etc.) lands inside this file with no
 * call-site changes.
 *
 * See ADR 0012 (admin parallel services) for the two-runtime split rationale
 * and `.patterns/effect-layer-composition.md#multiple-runtimes--graphql--admin`
 * for the wiring shape.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import {Context, Data, Effect, Layer} from "effect";

/**
 * Does this env open the dev-only surfaces (the `/api/admin/*` seeder + clear
 * routes)? Fail-closed: open only when `ENVIRONMENT === "development"`.
 *
 * Kept as a pure predicate over `{ENVIRONMENT: string}` so the gate is testable
 * without evaluating the alchemy `Worker` class. The worker init reads
 * `Cloudflare.WorkerEnvironment` and feeds it here to derive the `allowed`
 * flag the `adminAuthLayer(...)` value layer carries.
 */
export const adminAllowed = (env: {readonly ENVIRONMENT: string}): boolean =>
	env.ENVIRONMENT === "development";

/**
 * Raised when an admin operation is attempted outside an allowed context.
 * Maps to a 403 at the HTTP edge.
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
 * Live layer — derives `allowed` from the alchemy `WorkerEnvironment`. Reads
 * the deploy-resolved `ENVIRONMENT` string off the runtime env record (widened
 * from the generated `Env`'s `"development"` literal to a real string at the
 * boundary), then runs it through {@link adminAllowed}. In production the
 * admin routes are inert. Future versions can yield richer signals (Pasaport
 * karma, signed tokens) without changing the call sites.
 */
export const AdminAuthLive = Layer.effect(AdminAuth)(
	Effect.gen(function* () {
		const env = yield* Cloudflare.WorkerEnvironment;
		return {
			allowed: adminAllowed({ENVIRONMENT: (env as {ENVIRONMENT?: string}).ENVIRONMENT ?? ""}),
		};
	}),
);
