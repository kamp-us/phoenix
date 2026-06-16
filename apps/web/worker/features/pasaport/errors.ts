/**
 * Tagged errors raised by the Pasaport service layer. Each class carries its
 * wire `code` as an `ErrorCode` annotation that `encodeWireError` reads at the
 * fate boundary (`.patterns/fate-effect-wire-errors.md`). One static code per
 * class (the codec reads the CONSTRUCTOR annotation), so each username sub-code
 * is its own class and {@link UsernameInvalid} is the union alias the service
 * signatures name. Wire codes are pinned verbatim in `errors.unit.test.ts` so
 * SPA pattern-matching can't drift.
 *
 * The package's `Unauthorized` (annotated `UNAUTHORIZED`) gates the writes via
 * `CurrentUser.required` and is not redeclared here.
 */
import {ErrorCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

export class UsernameInvalidFormat extends Schema.TaggedErrorClass<UsernameInvalidFormat>()(
	"pasaport/UsernameInvalidFormat",
	{message: Schema.String},
	{[ErrorCode]: "INVALID_FORMAT"},
) {}

export class UsernameTooShort extends Schema.TaggedErrorClass<UsernameTooShort>()(
	"pasaport/UsernameTooShort",
	{message: Schema.String},
	{[ErrorCode]: "TOO_SHORT"},
) {}

export class UsernameTooLong extends Schema.TaggedErrorClass<UsernameTooLong>()(
	"pasaport/UsernameTooLong",
	{message: Schema.String},
	{[ErrorCode]: "TOO_LONG"},
) {}

// Spread into the mutation `error:` union; {@link UsernameInvalid} is derived
// from this tuple, so the two can never drift.
export const UsernameInvalidErrors = [
	UsernameInvalidFormat,
	UsernameTooShort,
	UsernameTooLong,
] as const;

// The union the `Pasaport` service signatures declare, derived from
// {@link UsernameInvalidErrors}.
export type UsernameInvalid = InstanceType<(typeof UsernameInvalidErrors)[number]>;

export class UsernameTaken extends Schema.TaggedErrorClass<UsernameTaken>()(
	"pasaport/UsernameTaken",
	{
		message: Schema.String,
	},
	{[ErrorCode]: "TAKEN"},
) {}

// Username is immutable once set; re-setting fails with this.
export class UsernameAlreadySet extends Schema.TaggedErrorClass<UsernameAlreadySet>()(
	"pasaport/UsernameAlreadySet",
	{
		message: Schema.String,
	},
	{[ErrorCode]: "ALREADY_SET"},
) {}

export class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()(
	"pasaport/UserNotFound",
	{
		message: Schema.String,
	},
	{[ErrorCode]: "USER_NOT_FOUND"},
) {}
