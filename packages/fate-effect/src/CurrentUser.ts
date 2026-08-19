/**
 * `CurrentUser` — the per-request session service (ADR 0042), half of the
 * server's per-request contract with `LivePublisher`. No worker-level layer
 * provides it; `Provision.ts` provides the pair onto each handler per request,
 * so `FateServer.layer` excludes both from its R.
 *
 * The shape stays minimal on purpose: anything richer than session identity
 * (karma) is a database read behind a domain service, not session state.
 */
import {Context, Effect} from "effect";
import * as Schema from "effect/Schema";
import {FateWireCode} from "./WireError.ts";

/** A structural subset of the better-auth session user. */
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

export class CurrentUser extends Context.Service<
	CurrentUser,
	{readonly user: CurrentUserInfo | undefined}
>()("fate-effect/CurrentUser") {
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
