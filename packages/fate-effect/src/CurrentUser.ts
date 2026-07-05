/**
 * `CurrentUser` — the per-request session service, half of the server's
 * per-request contract (`LivePublisher` is the other half).
 *
 * Handlers `yield*` it like any other service, but no worker-level layer ever
 * provides it: the provision pipeline (`Provision.ts`) provides the pair onto
 * each handler
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
 * `image`/`username`) — a structural subset of the better-auth session user, so
 * the worker provides it from the session value directly. `username` is the
 * public handle (a better-auth `additionalFields.username`, nullable until an
 * account bootstraps it) — it rides on the session so a write path can persist a
 * non-PII display label without a second DB read. Anything richer (karma) is a
 * database read behind a domain service, not session state.
 */
import {Context, Effect} from "effect";
import * as Schema from "effect/Schema";
import {FateWireCode} from "./WireError.ts";

/**
 * The identity of the authenticated user, as resolvers consume it — a
 * structural subset of the better-auth session user.
 */
export interface CurrentUserInfo {
	readonly id: string;
	readonly email: string;
	/**
	 * Display name — NULLABLE: the `user.name` column is nullable and the magic-link
	 * signup mints nameless accounts (only email/password signup supplies a name). The
	 * type must reflect that (the old non-null `string` lie is what made the
	 * `name ?? email` PII fallback look safe, #2130); a null-name write flattens through
	 * `authorDisplayLabel`, never email.
	 */
	readonly name: string | null;
	readonly image?: string | null | undefined;
	/**
	 * Public handle (better-auth `additionalFields.username`), `null` until the
	 * account bootstraps one. Carried on the session so a write path can resolve a
	 * non-PII author label (name → `@username` → fallback) without a DB read — the
	 * `email` field is NEVER a display fallback (a null name must not leak email).
	 */
	readonly username?: string | null | undefined;
}

/**
 * An authenticated user was required but the request is anonymous. Annotated
 * `UNAUTHORIZED` — the wire code the SPA already decodes for gated writes —
 * so `encodeWireError` derives the wire shape with no registry edit.
 */
export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
	"fate-effect/Unauthorized",
	{message: Schema.String},
	{[FateWireCode]: "UNAUTHORIZED"},
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
