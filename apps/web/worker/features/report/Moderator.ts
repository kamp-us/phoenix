/**
 * `Moderator` — the moderation capability (ADR 0098 §2). Mirrors
 * {@link CurrentUser.required}: the only way to obtain a {@link ModeratorIdentity}
 * is to discharge {@link Moderator.required}, which reads the caller's `role` from
 * D1 (through {@link Pasaport}) and either yields the token or fails. There is no
 * code path that moderates without first discharging it — "moderated without being
 * a moderator" does not typecheck, the way `CurrentUser.required` makes
 * "wrote while anonymous" untypeable.
 *
 * Authority is read from D1 at the point of use, never trusted from session state:
 * `CurrentUserInfo` carries only id/email/name/image, so the richer `role` read
 * goes through the identity service (the CLAUDE.md "richer reads behind a domain
 * service" rule). No env allowlist, no `if (isMod)` branch — the gate is structural.
 */
import {CurrentUser, type CurrentUserInfo, ErrorCode, type Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Pasaport} from "../pasaport/Pasaport.ts";

/**
 * The token a moderation action holds — proof the gate was discharged. Carries
 * the moderator's `user.id` so the action stamps `resolver_id` / `removed_by`
 * from the authenticated, authority-checked identity.
 */
export interface ModeratorIdentity {
	readonly id: string;
	readonly email: string;
	readonly name: string;
}

/**
 * An authenticated user attempted a moderation action without the `moderator`
 * role. Annotated `UNAUTHORIZED` — the SAME wire code an anonymous caller gets —
 * so the moderation surface is invisible to non-moderators: the client cannot
 * distinguish "you are not a moderator" from "you are not signed in" (ADR 0098 §2).
 */
export class NotAModerator extends Schema.TaggedErrorClass<NotAModerator>()(
	"report/NotAModerator",
	{message: Schema.String},
	{[ErrorCode]: "UNAUTHORIZED"},
) {}

export const Moderator = {
	/**
	 * Require the caller to be a moderator. Fails `Unauthorized` if anonymous,
	 * `NotAModerator` if authenticated-but-not. The role is read fresh from D1, so
	 * a revoked moderator is denied on the next call with no session to invalidate.
	 *
	 * @example
	 *   Effect.fn("report.resolve")(function* ({input}) {
	 *     const mod = yield* Moderator.required;
	 *     ...
	 *   })
	 */
	required: Effect.gen(function* () {
		const user: CurrentUserInfo = yield* CurrentUser.required;
		const pasaport = yield* Pasaport;
		const row = yield* pasaport.getUserById(user.id);
		if (!row || row.role !== "moderator") {
			return yield* new NotAModerator({message: "Moderator authority required"});
		}
		return {id: user.id, email: user.email, name: user.name} satisfies ModeratorIdentity;
	}) as Effect.Effect<ModeratorIdentity, Unauthorized | NotAModerator, CurrentUser | Pasaport>,
};
