/**
 * Test doubles for every service `currentSandboxViewer` reads, bundled by axis so a
 * unit test states a viewer shape in a line or two instead of re-stubbing seven
 * services: the in-place axis (#6423 — the flag, the per-request flag plumbing, the
 * künye tier, the #6422 opt-in store), the moderator axis (#6424 — the actor, the
 * fail-closed agent authority, the `moderates` tuple store), and both together.
 *
 * The stores fail on contact by default, so a test that expects a short-circuit
 * (flag off, anonymous, or a non-yazar tier) proves the read never happened rather
 * than asserting on a value nobody produced.
 */
import {AgentAuthority, CurrentActor, human, RelationStore} from "@kampus/authz";
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

/**
 * The two stores the in-place probe reads once past the flag, WITHOUT the flag itself —
 * for a test that already stubs `Flags` for a different gate (a resolver dark-shipped
 * behind its own key) and only needs the probe's residual context discharged.
 */
export const inPlaceVisibilityStores = ({
	tier,
	preference,
}: Omit<InPlaceVisibilityStubs, "flagOn">): Layer.Layer<CaylakVisibility | Kunye> =>
	Layer.mergeAll(
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
	);

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
		inPlaceVisibilityStores({
			...(tier !== undefined ? {tier} : {}),
			...(preference !== undefined ? {preference} : {}),
		}),
		Layer.succeed(RuntimeContext, runtimeContextStub),
	);

/** The dark-flag default: nothing downstream of the flag may be touched. */
export const inPlaceVisibilityOff = inPlaceVisibilityLayer({flagOn: false});

/**
 * The moderator axis `currentSandboxViewer` probes through `requireModeration` —
 * `CurrentActor`, the fail-closed `AgentAuthority`, and the `moderates` tuple store —
 * bundled so a test states "a moderator" or "not a moderator" in one line.
 */
export const moderatorAxisLayer = ({
	viewerId,
	isModerator,
}: {
	readonly viewerId: string;
	readonly isModerator: boolean;
}): Layer.Layer<AgentAuthority | CurrentActor | RelationStore> =>
	Layer.mergeAll(
		Layer.succeed(CurrentActor, {actor: human(viewerId)}),
		Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(false)}),
		Layer.succeed(RelationStore, {
			has: () => Effect.succeed(isModerator),
			hasSubjects: () => Effect.die("RelationStore.hasSubjects not exercised"),
			subjectsOf: () => Effect.die("RelationStore.subjectsOf not exercised"),
		}),
	);

/**
 * Every service `currentSandboxViewer` reads, in one layer: the in-place axis
 * ({@link inPlaceVisibilityLayer}) and the moderator axis ({@link moderatorAxisLayer}).
 * A test that drives a resolver through the real viewer resolution states both axes
 * here instead of re-stubbing seven services.
 */
export const sandboxViewerLayer = (
	stubs: InPlaceVisibilityStubs & {readonly viewerId: string; readonly isModerator: boolean},
): Layer.Layer<
	| AgentAuthority
	| CaylakVisibility
	| CurrentActor
	| Flags
	| Kunye
	| RelationStore
	| RequestFlagOverrides
	| RuntimeContext
> =>
	Layer.mergeAll(
		inPlaceVisibilityLayer(stubs),
		moderatorAxisLayer({viewerId: stubs.viewerId, isModerator: stubs.isModerator}),
	);
