/**
 * The SDK versions a program supports, and the check a desk runs before it loads one (#9686,
 * ruling #9668 R2.2). A desk supplies its one copy of this SDK to every program, so a program built
 * against a different one is refused rather than loaded: two copies of an Effect-based SDK in one
 * process do not share service keys, and every lookup across them fails.
 *
 * A program declares its range as a semver range on its row's `sdk` field, the way an extension
 * declares `engines.vscode`. A row that declares none supports every SDK of the desk's own major
 * (`^<major>`), so the rows written before ranges existed keep loading on the desk they were written
 * for.
 */

import {Result, Schema} from "effect";
import semver from "semver";

/** The package a declared range is about, as a refusal names it. */
export const SDK_PACKAGE = "@kampus/tuval-sdk";

/** A program whose declared range does not include the desk's SDK version. */
export class SdkOutOfRange extends Schema.TaggedError<SdkOutOfRange>()("tuval/SdkOutOfRange", {
	program: Schema.String,
	range: Schema.String,
	sdk: Schema.String,
}) {
	override get message(): string {
		return `program "${this.program}" supports ${SDK_PACKAGE} ${this.range}, and this desk runs ${this.sdk}; it was not loaded`;
	}
}

/** A program whose declared range is not a semver range at all. */
export class SdkRangeMalformed extends Schema.TaggedError<SdkRangeMalformed>()(
	"tuval/SdkRangeMalformed",
	{program: Schema.String, range: Schema.String, sdk: Schema.String},
) {
	override get message(): string {
		return `program "${this.program}" declares ${SDK_PACKAGE} range ${JSON.stringify(this.range)}, which is not a semver range (this desk runs ${this.sdk}); it was not loaded`;
	}
}

export type SdkRefused = SdkOutOfRange | SdkRangeMalformed;

/** The range a row that declares none supports: every SDK of the desk's own major. */
export const defaultSdkRange = (sdk: string): string => `^${semver.major(sdk)}`;

/**
 * May the program `program` load on a desk running SDK `sdk`? `declared` is the row's `sdk` field
 * as the config handed it over, which is why it is `unknown`: a config row is opaque past its id,
 * so a range that is not a string is malformed here rather than trusted.
 *
 * A prerelease desk SDK is compared as the release it leads up to, so a `^1` program loads on a
 * `1.0.0-rc.1` desk.
 */
export const admitSdk = (
	program: string,
	declared: unknown,
	sdk: string,
): Result.Result<string, SdkRefused> => {
	if (declared === undefined) return Result.succeed(defaultSdkRange(sdk));
	const range = typeof declared === "string" ? declared : String(declared);
	if (typeof declared !== "string" || semver.validRange(declared) === null) {
		return Result.fail(new SdkRangeMalformed({program, range, sdk}));
	}
	return semver.satisfies(sdk, declared, {includePrerelease: true})
		? Result.succeed(declared)
		: Result.fail(new SdkOutOfRange({program, range, sdk}));
};
