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
import {toAccountDeletionReceipt, toUser} from "./shapers.ts";
import {AccountDeletionReceiptView, UserView} from "./views.ts";

const SetUsernameInput = Schema.Struct({
	value: Schema.String,
});

/**
 * The exact phrase the client must echo to fire `account.delete` (ADR 0097 §4).
 * It is a `Schema.Literal`, so an absent or wrong confirmation is an input-DECODE
 * failure — the mutation body never runs on a malformed/replayed request, and
 * "deleted by accident" is unrepresentable rather than a silent execution. Turkish
 * user-facing copy (the SPA shows it; the user types it back verbatim).
 */
export const ACCOUNT_DELETE_CONFIRMATION = "hesabımı kalıcı olarak sil";

const DeleteAccountInput = Schema.Struct({
	confirmation: Schema.Literal(ACCOUNT_DELETE_CONFIRMATION),
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

	// Account deletion = anonymize-to-`@[silinen]` (ADR 0097). Synchronous, gated
	// by `CurrentUser.required` (anonymous → `UNAUTHORIZED`); the target is ALWAYS
	// the caller (`user.id`) — there is no "delete user X" arg, so anonymizing
	// someone else is unrepresentable at this surface. The typed-confirmation gate
	// lives in `DeleteAccountInput` (a `Schema.Literal`): a wrong/absent token fails
	// input decode before the body runs. The teardown is `Pasaport.anonymizeAccount`
	// (ADR 0013 — domain logic in the service, not the resolver).
	"account.delete": Fate.mutation(
		{
			input: DeleteAccountInput,
			type: AccountDeletionReceiptView,
			error: Unauthorized,
		},
		Effect.fn("account.delete")(function* () {
			const user = yield* CurrentUser.required;
			const pasaport = yield* Pasaport;
			yield* pasaport.anonymizeAccount({userId: user.id});
			return toAccountDeletionReceipt();
		}),
	),
};
