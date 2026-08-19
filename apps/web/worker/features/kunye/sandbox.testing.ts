/**
 * Test doubles for the four services `currentSandboxViewer`'s in-place-visibility
 * resolution (#6423) reads: the flag, the per-request flag plumbing, the künye tier,
 * and the #6422 opt-in store. Bundled as ONE layer so a unit test that only cares
 * about the moderator/author axes states "in-place off" in a single line instead of
 * re-stubbing four services.
 *
 * The stores fail on contact by default, so a test that expects a short-circuit
 * (flag off, anonymous, or a non-yazar tier) proves the read never happened rather
 * than asserting on a value nobody produced.
 */
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {
	CaylakVisibility,
	type CaylakVisibilityState,
} from "../caylak-visibility/CaylakVisibility.ts";
import {Flags} from "../flagship/Flags.ts";
import {RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import {Kunye} from "./Kunye.ts";
import type {Tier} from "./standing.ts";

const runtimeContextStub: BaseRuntimeContext = {
	Type: "sandbox-viewer-test",
	id: "sandbox-viewer-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

export interface InPlaceVisibilityStubs {
	/** `phoenix-caylak-visibility`'s value for this request. */
	readonly flagOn: boolean;
	/** The viewer's stored tier; omit to fail the test if the tier is read at all. */
	readonly tier?: Tier;
	/** The viewer's opt-in state; omit to fail the test if the store is read at all. */
	readonly preference?: CaylakVisibilityState;
}

export const inPlaceVisibilityLayer = ({
	flagOn,
	tier,
	preference,
}: InPlaceVisibilityStubs): Layer.Layer<
	CaylakVisibility | Flags | Kunye | RequestFlagOverrides | RuntimeContext
> =>
	Layer.mergeAll(
		Layer.succeed(Flags, {
			getBoolean: () => Effect.succeed(flagOn),
			getString: () => Effect.die("getString not exercised"),
			getNumber: () => Effect.die("getNumber not exercised"),
			getObject: () => Effect.die("getObject not exercised"),
		} as typeof Flags.Service),
		Layer.succeed(RequestFlagOverrides, {cookieHeader: null, overridesAllowed: false}),
		Layer.succeed(Kunye, {
			tierOf: () =>
				tier === undefined
					? Effect.die("the tier was read on a short-circuit path")
					: Effect.succeed(tier),
			karmaOf: () => Effect.die("Kunye.karmaOf not exercised"),
			rootOf: () => Effect.die("Kunye.rootOf not exercised"),
		}),
		Layer.succeed(CaylakVisibility, {
			read: () =>
				preference === undefined
					? Effect.die("the opt-in store was read on a short-circuit path")
					: Effect.succeed(preference),
			set: () => Effect.die("CaylakVisibility.set not exercised"),
		}),
		Layer.succeed(RuntimeContext, runtimeContextStub),
	);

/** The dark-flag default: nothing downstream of the flag may be touched. */
export const inPlaceVisibilityOff = inPlaceVisibilityLayer({flagOn: false});
