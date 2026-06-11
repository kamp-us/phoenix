/**
 * `CurrentUser` — the per-request session service, half of the server's
 * per-request contract (PRD story 8; `LivePublisher` is the other half).
 *
 * Handlers `yield*` it like any other service, but no worker-level layer ever
 * provides it: the compile step (task 7) provides the pair onto each handler
 * per request — `CurrentUser` from the session, `LivePublisher` from the
 * request's execution context. `FateServer.layer` therefore EXCLUDES both
 * from its R (`FateServerRequirements` in `Server.ts`); a handler's
 * dependency on them is visible in its own type and discharged at the fate
 * edge, never at `Layer.provide` time. This is what makes the bridge's
 * `FateContext` smuggling unnecessary.
 *
 * The shape is deliberately minimal: `user` is `undefined` for anonymous
 * traffic (mirroring the worker's `Auth`), and {@link CurrentUserInfo} carries
 * exactly the identity fields phoenix resolvers consume (`id`/`email`/`name`/
 * `image`) — a structural subset of the better-auth session user, so the
 * worker provides it from the session value directly. Anything richer
 * (username, karma) is a database read behind a domain service, not session
 * state.
 */
import {Context, Effect} from "effect";
import * as Schema from "effect/Schema";
import {WireCode} from "./WireError.ts";

/**
 * The identity of the authenticated user, as resolvers consume it — a
 * structural subset of the better-auth session user.
 */
export interface CurrentUserInfo {
	readonly id: string;
	readonly email: string;
	readonly name: string;
	readonly image?: string | null | undefined;
}

/**
 * An authenticated user was required but the request is anonymous. Annotated
 * `UNAUTHORIZED` — the wire code the SPA already decodes for gated writes —
 * so `encodeWireError` derives the wire shape with no registry edit.
 */
export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
	"fate-effect/Unauthorized",
	{message: Schema.String},
	{[WireCode]: "UNAUTHORIZED"},
) {}

/**
 * Per-request session state. `user` is `undefined` for anonymous traffic;
 * writes gate on {@link CurrentUser.required}.
 */
export class CurrentUser extends Context.Service<
	CurrentUser,
	{readonly user: CurrentUserInfo | undefined}
>()("fate-effect/CurrentUser") {
	/**
	 * Require an authenticated user — fails with {@link Unauthorized} otherwise.
	 *
	 * @example
	 *   Effect.fn("definition.add")(function* ({input}) {
	 *     const user = yield* CurrentUser.required;
	 *     ...
	 *   })
	 */
	static readonly required: Effect.Effect<CurrentUserInfo, Unauthorized, CurrentUser> = Effect.gen(
		function* () {
			const {user} = yield* CurrentUser;
			if (user === undefined) {
				return yield* new Unauthorized({message: "Authentication required"});
			}
			return user;
		},
	);
}
