/**
 * The per-request sandbox-viewer memo (#6457). Every assertion here is a call count, not
 * a value: the viewer a memoized read returns is the one the unmemoized read already
 * returned (`sandbox-viewer.unit.test.ts` pins that), so only the number of D1 round
 * trips can tell the memo apart from what it replaced.
 *
 * The stubs are `yieldNow`-punctuated, so the concurrent case genuinely has two fibers
 * in the resolution at once — with synchronous stubs the first would run to completion
 * before the second started, and a broken memo would pass.
 */
import {assert, describe, it} from "@effect/vitest";
import {AgentAuthority, CurrentActor, human, RelationStore} from "@kampus/authz";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Context, Effect, Layer} from "effect";
import {CaylakVisibility} from "../caylak-visibility/CaylakVisibility.ts";
import {Flags} from "../flagship/Flags.ts";
import {RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {Kunye} from "./Kunye.ts";
import {currentSandboxViewer, makeSandboxViewerMemo, SandboxViewerMemo} from "./sandbox.ts";

const VIEWER = {id: "yzr", email: "kaan@kamp.us", name: "kaan", image: null};

interface Counts {
	moderatorProbe: number;
	tierOf: number;
	preference: number;
}

const runtimeContextStub: BaseRuntimeContext = {
	Type: "sandbox-viewer-memo-test",
	id: "sandbox-viewer-memo-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

/** Every service the resolution reads, each counting its own invocations. */
const countingLayer = (counts: Counts, options: {readonly flagOn: boolean}) =>
	Layer.mergeAll(
		Layer.succeed(CurrentUser, {user: VIEWER}),
		Layer.succeed(CurrentActor, {actor: human(VIEWER.id)}),
		Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(false)}),
		Layer.succeed(RelationStore, {
			has: () =>
				Effect.gen(function* () {
					counts.moderatorProbe += 1;
					yield* Effect.yieldNow;
					return false;
				}),
			hasSubjects: () => Effect.die("RelationStore.hasSubjects not exercised"),
			subjectsOf: () => Effect.die("RelationStore.subjectsOf not exercised"),
		}),
		Layer.succeed(Flags, {
			getBoolean: () => Effect.succeed(options.flagOn),
			getString: () => Effect.die("getString not exercised"),
			getNumber: () => Effect.die("getNumber not exercised"),
			getObject: () => Effect.die("getObject not exercised"),
		} as typeof Flags.Service),
		Layer.succeed(RequestFlagOverrides, {cookieHeader: null, overridesAllowed: false}),
		Layer.succeed(Kunye, {
			tierOf: () =>
				Effect.gen(function* () {
					counts.tierOf += 1;
					yield* Effect.yieldNow;
					return "yazar" as const;
				}),
			karmaOf: () => Effect.die("Kunye.karmaOf not exercised"),
			rootOf: () => Effect.die("Kunye.rootOf not exercised"),
		}),
		Layer.succeed(CaylakVisibility, {
			read: () =>
				Effect.gen(function* () {
					counts.preference += 1;
					yield* Effect.yieldNow;
					return {optedIn: true, setAt: new Date("2026-08-19T00:00:00.000Z")};
				}),
			set: () => Effect.die("CaylakVisibility.set not exercised"),
		}),
		Layer.succeed(RuntimeContext, runtimeContextStub),
	);

type StubbedServices = Layer.Success<ReturnType<typeof countingLayer>>;

/**
 * One request: build the memo the way `fate/route.ts` does, install it on a context the
 * way `requestServices` does, and run `body` under it.
 */
const underOneRequest = <A>(
	counts: Counts,
	body: Effect.Effect<A, never, StubbedServices>,
	options: {readonly flagOn: boolean} = {flagOn: true},
): Effect.Effect<A> =>
	Effect.gen(function* () {
		const memo = yield* makeSandboxViewerMemo;
		return yield* body.pipe(Effect.provideContext(Context.make(SandboxViewerMemo, memo)));
	}).pipe(Effect.provide(countingLayer(counts, options)));

const freshCounts = (): Counts => ({moderatorProbe: 0, tierOf: 0, preference: 0});

describe("the per-request sandbox-viewer memo (#6457)", () => {
	it.effect("two call sites in one request resolve the viewer once", () => {
		const counts = freshCounts();
		return Effect.gen(function* () {
			const [first, second] = yield* underOneRequest(
				counts,
				Effect.gen(function* () {
					const a = yield* currentSandboxViewer;
					const b = yield* currentSandboxViewer;
					return [a, b] as const;
				}),
			);
			assert.deepStrictEqual(counts, {moderatorProbe: 1, tierOf: 1, preference: 1});
			assert.deepStrictEqual(first, {
				viewerId: VIEWER.id,
				canSeeSandboxed: false,
				seesSandboxedInPlace: true,
			} satisfies SandboxViewer);
			assert.deepStrictEqual(second, first);
		});
	});

	it.effect("concurrent call sites collapse to one resolution — the memo is single-flight", () => {
		const counts = freshCounts();
		return Effect.gen(function* () {
			const viewers = yield* underOneRequest(
				counts,
				Effect.all([currentSandboxViewer, currentSandboxViewer, currentSandboxViewer], {
					concurrency: "unbounded",
				}),
			);
			assert.deepStrictEqual(counts, {moderatorProbe: 1, tierOf: 1, preference: 1});
			assert.deepStrictEqual(viewers[1], viewers[0]);
			assert.deepStrictEqual(viewers[2], viewers[0]);
		});
	});

	it.effect(
		"building the memo reads nothing — a request touching no call site pays nothing",
		() => {
			const counts = freshCounts();
			return Effect.gen(function* () {
				yield* underOneRequest(counts, Effect.void);
				assert.deepStrictEqual(counts, {moderatorProbe: 0, tierOf: 0, preference: 0});
			});
		},
	);

	it.effect("the memo does not defeat the flag short-circuit", () => {
		const counts = freshCounts();
		return Effect.gen(function* () {
			const viewer = yield* underOneRequest(counts, currentSandboxViewer, {flagOn: false});
			assert.isFalse(viewer.seesSandboxedInPlace);
			assert.deepStrictEqual(counts, {moderatorProbe: 1, tierOf: 0, preference: 0});
		});
	});

	// The default is what a caller outside `POST /fate` gets — a unit test, or the
	// long-lived `/fate/live` connection, where memoizing a viewer across frames would
	// serve a stale one. It must resolve fresh, which is exactly this count.
	it.effect("with no memo installed, every call site resolves for itself", () => {
		const counts = freshCounts();
		return Effect.gen(function* () {
			yield* currentSandboxViewer;
			yield* currentSandboxViewer;
			assert.deepStrictEqual(counts, {moderatorProbe: 2, tierOf: 2, preference: 2});
		}).pipe(Effect.provide(countingLayer(counts, {flagOn: true})));
	});
});
