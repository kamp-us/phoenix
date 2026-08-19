/**
 * Tagged errors raised by the Pasaport service layer. See
 * `.patterns/fate-effect-wire-errors.md`. The codec reads the CONSTRUCTOR annotation, so
 * one static code per class — that is why each username sub-code is its own class.
 */
import {FateWireCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

export class UsernameInvalidFormat extends Schema.TaggedErrorClass<UsernameInvalidFormat>()(
	"pasaport/UsernameInvalidFormat",
	{message: Schema.String},
	{[FateWireCode]: "INVALID_FORMAT"},
) {}

export class UsernameTooShort extends Schema.TaggedErrorClass<UsernameTooShort>()(
	"pasaport/UsernameTooShort",
	{message: Schema.String},
	{[FateWireCode]: "TOO_SHORT"},
) {}

export class UsernameTooLong extends Schema.TaggedErrorClass<UsernameTooLong>()(
	"pasaport/UsernameTooLong",
	{message: Schema.String},
	{[FateWireCode]: "TOO_LONG"},
) {}

export const UsernameInvalidErrors = [
	UsernameInvalidFormat,
	UsernameTooShort,
	UsernameTooLong,
] as const;

export type UsernameInvalid = InstanceType<(typeof UsernameInvalidErrors)[number]>;

export class UsernameTaken extends Schema.TaggedErrorClass<UsernameTaken>()(
	"pasaport/UsernameTaken",
	{
		message: Schema.String,
	},
	{[FateWireCode]: "TAKEN"},
) {}

// Username is immutable once set; re-setting fails with this.
export class UsernameAlreadySet extends Schema.TaggedErrorClass<UsernameAlreadySet>()(
	"pasaport/UsernameAlreadySet",
	{
		message: Schema.String,
	},
	{[FateWireCode]: "ALREADY_SET"},
) {}

export class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()(
	"pasaport/UserNotFound",
	{
		message: Schema.String,
	},
	{[FateWireCode]: "USER_NOT_FOUND"},
) {}

// The server-authoritative floor against a blank submit; the SPA's `required` input is
// not trusted to prevent a byline-blanking write.
export class DisplayNameEmpty extends Schema.TaggedErrorClass<DisplayNameEmpty>()(
	"pasaport/DisplayNameEmpty",
	{
		message: Schema.String,
	},
	{[FateWireCode]: "DISPLAY_NAME_EMPTY"},
) {}

// A ban MUST carry a reason — the audit record is meaningless without one — so the
// server rejects a blank submit even though the admin UI marks the field required.
export class BanReasonRequired extends Schema.TaggedErrorClass<BanReasonRequired>()(
	"pasaport/BanReasonRequired",
	{
		message: Schema.String,
	},
	{[FateWireCode]: "BAN_REASON_REQUIRED"},
) {}

// A manual failing-mark MUST carry a reason — it is the audit note for why the address
// was marked out-of-band. The matching `clear` carries none and has no such floor.
export class EmailFailingReasonRequired extends Schema.TaggedErrorClass<EmailFailingReasonRequired>()(
	"pasaport/EmailFailingReasonRequired",
	{
		message: Schema.String,
	},
	{[FateWireCode]: "EMAIL_FAILING_REASON_REQUIRED"},
) {}
