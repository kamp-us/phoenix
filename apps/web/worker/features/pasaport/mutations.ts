/**
 * Mutation resolvers — the pasaport (identity) write path.
 *
 * Per ADR 0020, mutations are `Fate.mutation` def + `Effect.fn` pairs named
 * `entity.verb` (`.patterns/fate-effect-operations.md`). `user.setUsername`
 * writes the immutable username + the `user_profile` identity upsert in one D1
 * batch via `Pasaport.setUsername`, then returns the re-resolved `User` entity
 * shaped exactly like the `me` read.
 *
 * Validation stays in the service (ADR 0013): `Pasaport.setUsername` enforces
 * the username constraints (length / format / uniqueness / immutability) and
 * raises the domain errors (the `UsernameInvalid` union, `UsernameTaken`,
 * `UsernameAlreadySet`, `UserNotFound`). Those surface through their
 * `fateWireCode` annotations as stable wire codes (`INVALID_FORMAT` /
 * `TOO_SHORT` / `TOO_LONG` / `TAKEN` / `ALREADY_SET` / `USER_NOT_FOUND`;
 * `.patterns/fate-effect-wire-errors.md`). `CurrentUser.required` gates the
 * write (anonymous → `UNAUTHORIZED`); the `DrizzleError` channel is
 * infrastructure and dies (`orDieDrizzle`).
 */

import {CurrentUser, Fate, Unauthorized} from "@phoenix/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {orDieDrizzle} from "../../db/Drizzle.ts";
import {toUser} from "../fate/shapers.ts";
import {UserNotFound, UsernameAlreadySet, UsernameInvalidErrors, UsernameTaken} from "./errors.ts";
import {Pasaport} from "./Pasaport.ts";
import {UserView} from "./views.ts";

const SetUsernameInput = Schema.Struct({
	value: Schema.String,
});

export const mutations = {
	"user.setUsername": Fate.mutation(
		{
			input: SetUsernameInput,
			type: UserView,
			error: Schema.Union([
				Unauthorized,
				...UsernameInvalidErrors,
				UsernameTaken,
				UsernameAlreadySet,
				UserNotFound,
			]),
		},
		Effect.fn("user.setUsername")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pasaport = yield* Pasaport;
			const result = yield* pasaport
				.setUsername({userId: user.id, value: input.value})
				.pipe(orDieDrizzle);
			// Re-resolve the affected `User` entity (email comes from the session;
			// the service result carries identity + the freshly-set username).
			return toUser({
				id: result.userId,
				email: user.email,
				name: result.displayName,
				image: result.image,
				username: result.username,
			});
		}),
	),
};
