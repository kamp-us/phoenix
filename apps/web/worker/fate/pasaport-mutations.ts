/**
 * Mutation resolvers — the pasaport (identity) write path.
 *
 * Per ADR 0020, mutations are `{type, input?, resolve: fateMutation(...)}`,
 * named `entity.verb`. `user.setUsername` writes the immutable username + the
 * `user_profile` identity upsert in one D1 batch via `Pasaport.setUsername`,
 * then returns the re-resolved `User` entity shaped exactly like the `me` read.
 *
 * Validation stays in the service (ADR 0013): `Pasaport.setUsername` enforces
 * the username constraints (length / format / uniqueness / immutability) and
 * raises the domain errors (`UsernameInvalid` with `code`, `UsernameTaken`,
 * `UsernameAlreadySet`, `UserNotFound`). Those surface through the bridge's
 * `encodeFateError` with the **same wire codes** as the GraphQL path
 * (`INVALID_FORMAT` / `TOO_SHORT` / `TOO_LONG` from the upcased `code`,
 * `TAKEN`, `ALREADY_SET`, `USER_NOT_FOUND`). `Auth.required` gates the write
 * (anonymous → `UNAUTHORIZED`).
 *
 * See `.patterns/fate-mutations.md`, `.patterns/fate-effect-bridge.md`.
 */

import {Pasaport} from "../features/pasaport/Pasaport";
import {Auth} from "../services";
import {fateMutation} from "./effect";
import type {User} from "./views";

export interface SetUsernameInput {
	value: string;
}

export const pasaportMutations = {
	"user.setUsername": {
		type: "User",
		resolve: fateMutation<SetUsernameInput, User>(function* ({input}) {
			const {user} = yield* Auth.required;
			const pasaport = yield* Pasaport;
			const result = yield* pasaport.setUsername({userId: user.id, value: input.value});
			// Re-resolve the affected `User` entity, matching the GraphQL
			// `setUsername` response shape (email comes from the session — the
			// service result carries identity + the freshly-set username).
			return {
				__typename: "User",
				id: result.userId,
				email: user.email,
				name: result.displayName,
				image: result.image,
				username: result.username,
			};
		}),
	},
};
