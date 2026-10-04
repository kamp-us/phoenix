/**
 * `currentInPlaceSandboxViewer`'s in-place-visibility resolution (#6423, epic #4306) — the
 * third viewer class, resolved from the #6422 opt-in behind `phoenix-caylak-visibility` —
 * and the narrow default beside it: `currentSandboxViewer` never carries that class, so
 * the widening is reachable only by name (#6467, ADR 0453).
 *
 * The load-bearing cells: the flag is the outer gate (off ⇒ `false`, and the store is
 * never read — the fail-on-contact double proves it); the yazar floor is re-checked at
 * READ time, so a çaylak or a visitor holding a stale preference row still resolves
 * `false`; and the widening lands on `seesSandboxedInPlace`, never on the moderator's
 * `canSeeSandboxed`.
 */
import {assert, describe, it} from "@effect/vitest";
import {AgentAuthority, CurrentActor, human, RelationStore, unauthenticated} from "@kampus/authz";
import {CurrentUser} from "@kampus/fate-effect";
import {Effect} from "effect";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {inPlaceVisibilityLayer} from "./sandbox.testing.ts";
import {
	currentInPlaceSandboxViewer,
	currentSandboxViewer,
	type SandboxViewerResolution,
} from "./sandbox.ts";
import type {Tier} from "./standing.ts";

const VIEWER = {id: "yzr", email: "kaan@kamp.us", name: "kaan", image: null};
const OPTED_IN_AT = new Date("2026-08-19T00:00:00.000Z");

// A `moderates`-tuple store nobody is in: every viewer below is a non-moderator, so
// `canSeeSandboxed` stays false and the assertions isolate the new axis.
const noModerators = {
	has: () => Effect.succeed(false),
	hasSubjects: () => Effect.succeed(new Set<string>()),
	subjectsOf: () => Effect.succeed(new Set<string>()),
} as never;

interface ViewerCase {
	readonly signedIn: boolean;
	readonly flagOn: boolean;
	readonly tier?: Tier;
	readonly optedIn?: boolean;
}

const resolveThrough = (
	path: SandboxViewerResolution,
	opts: ViewerCase,
): Effect.Effect<SandboxViewer> =>
	path.pipe(
		Effect.provideService(CurrentUser, {user: opts.signedIn ? VIEWER : undefined}),
		Effect.provideService(CurrentActor, {
			actor: opts.signedIn ? human(VIEWER.id) : unauthenticated,
		}),
		Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
		Effect.provideService(RelationStore, noModerators),
		Effect.provide(
			inPlaceVisibilityLayer({
				flagOn: opts.flagOn,
				...(opts.tier === undefined ? {} : {tier: opts.tier}),
				...(opts.optedIn === undefined
					? {}
					: {preference: opts.optedIn ? {optedIn: true, setAt: OPTED_IN_AT} : {optedIn: false}}),
			}),
		),
	);

const resolve = (opts: ViewerCase) => resolveThrough(currentInPlaceSandboxViewer, opts);

describe("currentSandboxViewer — narrow by default (#6467)", () => {
	it.effect("flag ON + opted-in yazar ⇒ false by default, true only when requested", () =>
		Effect.gen(function* () {
			const optedInYazar = {signedIn: true, flagOn: true, tier: "yazar", optedIn: true} as const;
			assert.deepStrictEqual(yield* resolveThrough(currentSandboxViewer, optedInYazar), {
				viewerId: VIEWER.id,
				canSeeSandboxed: false,
				seesSandboxedInPlace: false,
			});
			const widened = yield* resolveThrough(currentInPlaceSandboxViewer, optedInYazar);
			assert.isTrue(widened.seesSandboxedInPlace);
		}),
	);
});

describe("currentInPlaceSandboxViewer — the #6423 in-place opt-in", () => {
	it.effect("flag ON + yazar + opted in ⇒ the third class, and NOT moderator authority", () =>
		Effect.gen(function* () {
			const viewer = yield* resolve({signedIn: true, flagOn: true, tier: "yazar", optedIn: true});
			assert.deepStrictEqual(viewer, {
				viewerId: VIEWER.id,
				canSeeSandboxed: false,
				seesSandboxedInPlace: true,
			});
		}),
	);

	it.effect("flag ON + yazar + not opted in ⇒ false", () =>
		Effect.gen(function* () {
			const viewer = yield* resolve({signedIn: true, flagOn: true, tier: "yazar", optedIn: false});
			assert.isFalse(viewer.seesSandboxedInPlace);
		}),
	);

	// The stubs die on contact, so reaching either the tier read or the store fails here.
	it.effect("flag OFF ⇒ false, with no tier read and no preference read", () =>
		Effect.gen(function* () {
			const viewer = yield* resolve({signedIn: true, flagOn: false});
			assert.isFalse(viewer.seesSandboxedInPlace);
			assert.strictEqual(viewer.viewerId, VIEWER.id);
		}),
	);

	it.effect("an anonymous viewer resolves false even with the flag on and a row present", () =>
		Effect.gen(function* () {
			const viewer = yield* resolve({signedIn: false, flagOn: true, optedIn: true});
			assert.deepStrictEqual(viewer, {
				viewerId: null,
				canSeeSandboxed: false,
				seesSandboxedInPlace: false,
			});
		}),
	);

	for (const tier of ["çaylak", "visitor"] as const) {
		it.effect(`a ${tier} resolves false even with a stored opt-in row`, () =>
			Effect.gen(function* () {
				const viewer = yield* resolve({signedIn: true, flagOn: true, tier, optedIn: true});
				assert.isFalse(viewer.seesSandboxedInPlace);
			}),
		);
	}
});
