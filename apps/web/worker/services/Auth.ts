import {Context, Data, Effect} from "effect";
import type {Session} from "../features/pasaport/auth.ts";

/**
 * Thrown when an authenticated user is required but not present.
 */
export class Unauthorized extends Data.TaggedError("Unauthorized")<{
	readonly message: string;
}> {}

/**
 * Per-request auth state. `user`/`session` are undefined for anonymous traffic.
 */
export class Auth extends Context.Service<
	Auth,
	{
		readonly user: Session["user"] | undefined;
		readonly session: Session["session"] | undefined;
	}
>()("@phoenix/worker/Auth") {
	/**
	 * Require an authenticated user — fails with `Unauthorized` otherwise.
	 *
	 * @example
	 *   resolve: resolver(function* () {
	 *     const {user} = yield* Auth.required;
	 *     return {id: user.id, email: user.email};
	 *   })
	 */
	static readonly required = Effect.gen(function* () {
		const auth = yield* Auth;
		if (!auth.user) {
			return yield* new Unauthorized({message: "Authentication required"});
		}
		return {user: auth.user, session: auth.session};
	});
}
