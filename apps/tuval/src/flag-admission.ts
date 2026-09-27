/**
 * Feature flags are global only (#9687, ruling #9668 R4.2). The global config states them and a
 * project config may not: a project layer's `features` block refuses the layer. A row names the
 * flags it needs on its `needsFeatures` field, and a row needing a flag the global config leaves off
 * is refused on its own while the rest of its layer runs, the way an out-of-range SDK is
 * (`./sdk-admission.ts`).
 */

import type {TuvalConfig} from "@kampus/tuval-sdk/config";
import {featuresDefault, type TuvalFeatures} from "@kampus/tuval-sdk/kernel/features";
import {Result, Schema} from "effect";

/** A program that needs a flag this desk runs with off, or a flag this desk does not have. */
export class ProgramNeedsFlag extends Schema.TaggedError<ProgramNeedsFlag>()(
	"tuval/ProgramNeedsFlag",
	{
		program: Schema.String,
		flag: Schema.String,
		/** `off` for a known flag the global config leaves off; `unknown` for a name no flag has. */
		state: Schema.Literals(["off", "unknown"]),
	},
) {
	override get message(): string {
		return this.state === "off"
			? `program "${this.program}" needs feature flag "${this.flag}", which the global config leaves off; it was not loaded`
			: `program "${this.program}" needs feature flag ${JSON.stringify(this.flag)}, which this desk does not have; it was not loaded`;
	}
}

/** The flags a layer that states `stated` runs under: its own over the defaults. */
export const resolveFeatures = (stated: TuvalConfig["features"]): TuvalFeatures => ({
	...featuresDefault,
	...stated,
});

const isFlag = (name: unknown): name is keyof TuvalFeatures =>
	typeof name === "string" && Object.hasOwn(featuresDefault, name);

/**
 * May the program `program` load under `features`? `declared` is the row's `needsFeatures` field as
 * the config handed it over, `unknown` because a config row is opaque past its id: anything but an
 * array of flag names is a flag this desk does not have.
 */
export const admitFlags = (
	program: string,
	declared: unknown,
	features: TuvalFeatures,
): Result.Result<void, ProgramNeedsFlag> => {
	if (declared === undefined) return Result.void;
	if (!Array.isArray(declared)) {
		return Result.fail(new ProgramNeedsFlag({program, flag: String(declared), state: "unknown"}));
	}
	for (const flag of declared) {
		if (!isFlag(flag)) {
			return Result.fail(new ProgramNeedsFlag({program, flag: String(flag), state: "unknown"}));
		}
		if (!features[flag]) return Result.fail(new ProgramNeedsFlag({program, flag, state: "off"}));
	}
	return Result.void;
};

/** A project layer as it runs, once it states no flags. */
export const projectStatesNoFlags = (config: TuvalConfig): Result.Result<TuvalConfig, string> => {
	const stated = Object.keys(config.features);
	return stated.length === 0
		? Result.succeed(config)
		: Result.fail(
				`states feature flags (${stated.join(", ")}); flags are global only, so state them in the global .tuval/tuval.config.ts`,
			);
};
