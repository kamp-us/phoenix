/**
 * The two sözlük by-id definition re-reads carry the resolved `SandboxViewer` (#6586) —
 * `definition.react`'s flag-off inert re-read and `definition.edit`'s stamp read.
 *
 * `Sozluk.getDefinitionsByIds` masks on the sandbox dimension, so a degraded
 * `{viewerId}`-only viewer drops another author's still-sandboxed row and
 * `definition.react` answers `DefinitionNotFound` for an opted-in in-place yazar reading a
 * row their own term page shows them. `definition.edit` is author-only, so no viewer class
 * beyond the author can reach it — what is asserted there is the threading itself, the way
 * the pano twins were widened in #6424.
 *
 * The two flags are answered per key rather than alike: this file needs
 * `phoenix-reactions` OFF (to reach the inert branch) while `phoenix-caylak-visibility` is
 * ON (to resolve the in-place viewer), which one shared answer cannot express.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {PHOENIX_CAYLAK_VISIBILITY} from "../../../src/flags/keys.ts";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {Flags} from "../flagship/Flags.ts";
import {RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import {inPlaceVisibilityStores, moderatorAxisLayer} from "../kunye/sandbox.testing.ts";
import {
	lifecycleVisibilityRule,
	ruleVisibleTo,
	type SandboxViewer,
} from "../lifecycle/EntityLifecycle.ts";
import type {DefinitionRow} from "./definition-fields.ts";
import {mutations} from "./mutations.ts";
import {Sozluk} from "./Sozluk.ts";

const AUTHOR_ID = "u-caylak";
const VIEWER = {id: "u-yazar", email: "yazar@kamp.us", name: "yazar"};
const DEFINITION_ID = "def_sb1";
const OPTED_IN_AT = new Date("2026-08-19T00:00:00.000Z");

const runtimeContextStub: BaseRuntimeContext = {
	Type: "mutation-definition-reread-viewer",
	id: "mutation-definition-reread-viewer",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

/** Another author's still-sandboxed definition: only the in-place axis reaches it. */
const sandboxedDefinition: DefinitionRow = {
	id: DEFINITION_ID,
	body: "tanım",
	score: 3,
	author: "çaylak",
	authorId: AUTHOR_ID,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
	myVote: true,
};

const noopLive = Layer.succeed(LivePublisher)(
	livePublisherFor({publish: () => Effect.void, waitUntil: () => {}}),
);

// `phoenix-reactions` stays off (the inert branch); `phoenix-caylak-visibility` follows
// the case under test.
const flagsFor = (caylakVisibility: boolean): Layer.Layer<Flags | RequestFlagOverrides> =>
	Layer.mergeAll(
		Layer.succeed(Flags, {
			getBoolean: (key: string) =>
				Effect.succeed(key === PHOENIX_CAYLAK_VISIBILITY && caylakVisibility),
			getString: () => Effect.die("getString not exercised"),
			getNumber: () => Effect.die("getNumber not exercised"),
			getObject: () => Effect.die("getObject not exercised"),
		} as typeof Flags.Service),
		Layer.succeed(RequestFlagOverrides, {cookieHeader: null, overridesAllowed: false}),
	);

/**
 * `getDefinitionsByIds` applies the REAL sandbox rule to the viewer it was handed and
 * records it, so one context serves both the behavioural and the threading assertion.
 */
const contextFor = (optedIn: boolean, seen: SandboxViewer[]) =>
	Layer.mergeAll(
		// biome-ignore lint/plugin: a service double — the write is scripted and only the by-id re-read is under test.
		Layer.succeed(Sozluk, {
			editDefinition: () =>
				Effect.succeed({
					definitionId: DEFINITION_ID,
					score: sandboxedDefinition.score,
					body: sandboxedDefinition.body,
					authorId: AUTHOR_ID,
					authorName: "çaylak",
					createdAt: sandboxedDefinition.createdAt,
					updatedAt: sandboxedDefinition.updatedAt,
				}),
			getDefinitionsByIds: (_ids: ReadonlyArray<string>, opts: {sandboxViewer: SandboxViewer}) =>
				Effect.sync(() => {
					seen.push(opts.sandboxViewer);
					return ruleVisibleTo(
						lifecycleVisibilityRule.Sandboxed,
						sandboxedDefinition.authorId,
						opts.sandboxViewer,
					)
						? [sandboxedDefinition]
						: [];
				}),
		} as unknown as typeof Sozluk.Service),
		noopLive,
		flagsFor(optedIn),
		moderatorAxisLayer({viewerId: VIEWER.id, isModerator: false}),
		inPlaceVisibilityStores(
			optedIn ? {tier: "yazar", preference: {optedIn: true, setAt: OPTED_IN_AT}} : {},
		),
		Layer.succeed(CurrentUser, {user: VIEWER}),
		Layer.succeed(RuntimeContext, runtimeContextStub),
	);

const react = (optedIn: boolean, seen: SandboxViewer[]) =>
	resolveWire(mutations["definition.react"], {
		input: {id: DEFINITION_ID, emoji: null},
		select: ["id"],
	}).pipe(Effect.provide(contextFor(optedIn, seen)));

const edit = (optedIn: boolean, seen: SandboxViewer[]) =>
	resolveWire(mutations["definition.edit"], {
		input: {id: DEFINITION_ID, body: "yeni tanım"},
		select: ["id"],
	}).pipe(Effect.provide(contextFor(optedIn, seen)));

describe("the sözlük by-id definition re-reads carry the resolved viewer (#6586)", () => {
	it.effect("definition.react's inert re-read returns the row to an opted-in in-place yazar", () =>
		Effect.gen(function* () {
			const seen: SandboxViewer[] = [];
			const definition = yield* react(true, seen);
			assert.strictEqual(definition?.id, DEFINITION_ID);
			assert.deepStrictEqual(seen[0], {
				viewerId: VIEWER.id,
				canSeeSandboxed: false,
				seesSandboxedInPlace: true,
			});
		}),
	);

	it.effect("definition.react's inert re-read still masks the row from a plain yazar", () =>
		Effect.gen(function* () {
			const seen: SandboxViewer[] = [];
			const exit = yield* react(false, seen).pipe(Effect.exit);
			assert.isTrue(exit._tag === "Failure", "a masked row is DEFINITION_NOT_FOUND");
			assert.deepStrictEqual(seen[0], {
				viewerId: VIEWER.id,
				canSeeSandboxed: false,
				seesSandboxedInPlace: false,
			});
		}),
	);

	it.effect("definition.edit's stamp read is handed the resolved viewer, not a degraded one", () =>
		Effect.gen(function* () {
			const seen: SandboxViewer[] = [];
			yield* edit(true, seen);
			assert.deepStrictEqual(seen[0], {
				viewerId: VIEWER.id,
				canSeeSandboxed: false,
				seesSandboxedInPlace: true,
			});
		}),
	);
});
