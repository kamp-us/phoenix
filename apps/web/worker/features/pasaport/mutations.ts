/**
 * Mutation resolvers — the pasaport (identity) write path. `Fate.mutation` def +
 * `Effect.fn` pairs named `entity.verb` (ADR 0020;
 * `.patterns/fate-effect-operations.md`). Validation, constraints, and domain
 * errors stay in `Pasaport.setUsername` (ADR 0013); `CurrentUser.required` gates
 * the write (anonymous → `UNAUTHORIZED`).
 */

import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {UserNotFound, UsernameAlreadySet, UsernameInvalidErrors, UsernameTaken} from "./errors.ts";
import {Pasaport} from "./Pasaport.ts";
import {toUser} from "./shapers.ts";
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
			const result = yield* pasaport.setUsername({userId: user.id, value: input.value});
			// email comes from the session; the rest from the service result.
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
