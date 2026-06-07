/**
 * Tagged errors raised by the Pasaport service layer.
 *
 * Wire-code contract — every tag in this file maps to a specific
 * `code` string via `worker/features/fate/errors.ts::encodeFateError`:
 *
 *   pasaport/UsernameInvalid       → INVALID_FORMAT | TOO_SHORT | TOO_LONG
 *   pasaport/UsernameTaken         → TAKEN
 *   pasaport/UsernameAlreadySet    → ALREADY_SET
 *   pasaport/UserNotFound          → USER_NOT_FOUND
 *
 * `Unauthorized` is reused from `worker/features/pasaport/Auth.ts` and is not
 * redeclared here — `Auth.required` is the single source of truth for the
 * unauthorized wire code.
 */
import * as Schema from "effect/Schema";

/**
 * Sub-codes for username validation failures. They mirror the legacy
 * `UsernameValidationError.code` values so the wire format is preserved.
 */
export type UsernameInvalidCode = "invalid_format" | "too_short" | "too_long";

export class UsernameInvalid extends Schema.TaggedErrorClass<UsernameInvalid>()(
	"pasaport/UsernameInvalid",
	{
		code: Schema.Literals(["invalid_format", "too_short", "too_long"]),
		message: Schema.String,
	},
) {}

export class UsernameTaken extends Schema.TaggedErrorClass<UsernameTaken>()(
	"pasaport/UsernameTaken",
	{
		message: Schema.String,
	},
) {}

export class UsernameAlreadySet extends Schema.TaggedErrorClass<UsernameAlreadySet>()(
	"pasaport/UsernameAlreadySet",
	{
		message: Schema.String,
	},
) {}

export class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()("pasaport/UserNotFound", {
	message: Schema.String,
}) {}
