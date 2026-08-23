/**
 * `definition.add` ROUTING-boundary coverage (ADR 0039 / 0082): does the resolver
 * publish to the term's args-scoped `Term.definitions` topic (`{id: termSlug}`), or
 * leak to the procedure-wide global wildcard?
 *
 * Drives the REAL resolver over a stub `Sozluk` and a recording `LivePublisher`. The
 * publisher's key MATH is pinned separately in
 * `../fate-live/live-publisher.unit.test.ts`; this asserts the resolver's routing CHOICE.
 */

import {assert, it} from "@effect/vitest";
import {CurrentActor, human, RelationStore} from "@kampus/authz";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {liveConnectionTopic, liveGlobalConnectionTopic} from "@nkzw/fate/server";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {TermSlug} from "../../lib/ids.ts";
import {makeNotificationStub} from "../bildirim/Notification.testing.ts";
import {Divan} from "../divan/Divan.ts";
import {noRequestFlagOverrides} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {Flags} from "../flagship/Flags.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {mutations} from "./mutations.ts";
import type {AddDefinitionResult} from "./Sozluk.ts";
import {Sozluk} from "./Sozluk.ts";

class DrainRejected extends Schema.TaggedErrorClass<DrainRejected>()("test/DrainRejected", {
	cause: Schema.Unknown,
}) {}

const AUTHOR = {id: "u-author", email: "yazar@example.com", name: "yazar"};

const runtimeContextStub: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

// Every flag OFF ⇒ the karma-gates dep (#150) is inert and no karma is read.
const flagsOffStub = Layer.succeed(Flags, {
	getBoolean: () => Effect.succeed(false),
	getString: () => Effect.die("getString not exercised"),
	getNumber: () => Effect.die("getNumber not exercised"),
	getObject: () => Effect.die("getObject not exercised"),
} as typeof Flags.Service);

// A yazar author ⇒ `sandboxedAtForAuthor` returns null, so the add is a live-create.
const kunyeStub = Layer.succeed(Kunye, {
	tierOf: () => Effect.succeed("yazar" as const),
	karmaOf: () => Effect.succeed(0),
	rootOf: (id: string) => Effect.succeed(id),
} as typeof Kunye.Service);

// A yazar author ⇒ `notifyCaylakEntersDivan` short-circuits before touching these,
// so they exist only to satisfy the type and die on contact if ever reached.
const notificationStub = makeNotificationStub();
const divanStub = Layer.succeed(Divan, {
	roster: () => Effect.die("Divan.roster not exercised in definition-mutation"),
	backlogOf: () => Effect.die("Divan.backlogOf not exercised in definition-mutation"),
	pendingCountOf: () => Effect.die("Divan.pendingCountOf not exercised in definition-mutation"),
	pendingTotal: () => Effect.die("Divan.pendingTotal not exercised in definition-mutation"),
});
const relationStoreStub = Layer.succeed(RelationStore, {
	has: () => Effect.die("RelationStore.has not exercised in definition-mutation"),
	hasSubjects: () => Effect.die("RelationStore.hasSubjects not exercised in definition-mutation"),
	subjectsOf: () => Effect.die("RelationStore.subjectsOf not exercised in definition-mutation"),
});

// Every method other than `addDefinition` dies on contact, so a passing test proves
// `definition.add` reached only the write it routes around. `capture` records the write
// input so a test can assert the persisted `authorName` (#2130 — never the user's email).
const sozlukStub = (
	result: AddDefinitionResult,
	capture?: (input: {authorName: string}) => void,
): Layer.Layer<Sozluk> =>
	Layer.succeed(
		Sozluk,
		new Proxy(
			{
				addDefinition: (input: {authorName: string}) => {
					capture?.(input);
					return Effect.succeed(result);
				},
			} as Partial<typeof Sozluk.Service>,
			{
				get(target, prop) {
					if (prop in target) return (target as Record<string, unknown>)[prop as string];
					return () => Effect.die(`Sozluk.${String(prop)} not exercised in definition-mutation`);
				},
			},
		) as typeof Sozluk.Service,
	);

const ADD_RESULT: AddDefinitionResult = {
	definitionId: "d1",
	termCreated: true,
	score: 0,
	body: "an added definition",
	authorId: AUTHOR.id,
	authorName: AUTHOR.name,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
};

it.effect(
	"definition.add publishes to the args-scoped Term.definitions topic, not the wildcard",
	() =>
		Effect.gen(function* () {
			const slug = "fate-read";

			// `waitUntil` collects the fire-and-forget work so it can be drained below — the
			// publish is detached off the request path.
			const recorded: Array<string> = [];
			const scheduled: Array<Promise<unknown>> = [];
			const liveStub = Layer.succeed(LivePublisher)(
				livePublisherFor({
					publish: (topicKey) =>
						Effect.sync(() => {
							recorded.push(topicKey);
						}),
					waitUntil: (promise) => {
						scheduled.push(promise);
					},
				}),
			);

			yield* mutations["definition.add"]
				.handler({input: {termSlug: TermSlug.make(slug), body: ADD_RESULT.body}, select: ["id"]})
				.pipe(
					Effect.provide(
						Layer.mergeAll(
							sozlukStub(ADD_RESULT),
							liveStub,
							flagsOffStub,
							kunyeStub,
							notificationStub,
							divanStub,
							relationStoreStub,
							noRequestFlagOverrides,
						),
					),
					Effect.provideService(CurrentUser, {user: AUTHOR}),
					Effect.provideService(CurrentActor, {actor: human(AUTHOR.id)}),
					Effect.provideService(RuntimeContext, runtimeContextStub),
				);
			yield* Effect.tryPromise({
				try: () => Promise.allSettled(scheduled),
				catch: (cause) => new DrainRejected({cause}),
			}).pipe(Effect.orDie);

			assert.deepStrictEqual(recorded, [liveConnectionTopic("Term.definitions", {id: slug})]);
			// The ADR 0039 mis-route guard: dropping the args would land on the procedure-wide
			// wildcard, fanning one term's definition to every `Term.definitions` subscriber.
			assert.isFalse(recorded.includes(liveGlobalConnectionTopic("Term.definitions")));
		}),
);

// #2130 (PII-at-rest): a null-name account must NEVER have its EMAIL persisted as the
// denormalized `authorName` — the old `user.name ?? user.email` fallback did exactly
// that, and the flattened string renders publicly.
it.effect("definition.add never persists a null-name author's email as authorName", () =>
	Effect.gen(function* () {
		const nullNameUser = {id: "u-nameless", email: "leak@example.com", name: null, username: null};
		let captured: {authorName: string} | undefined;

		const liveStub = Layer.succeed(LivePublisher)(
			livePublisherFor({
				publish: () => Effect.void,
				waitUntil: () => {},
			}),
		);

		yield* mutations["definition.add"]
			.handler({input: {termSlug: TermSlug.make("gizli"), body: ADD_RESULT.body}, select: ["id"]})
			.pipe(
				Effect.provide(
					Layer.mergeAll(
						sozlukStub(ADD_RESULT, (input) => {
							captured = input;
						}),
						liveStub,
						flagsOffStub,
						kunyeStub,
						notificationStub,
						divanStub,
						relationStoreStub,
						noRequestFlagOverrides,
					),
				),
				Effect.provideService(CurrentUser, {user: nullNameUser}),
				Effect.provideService(CurrentActor, {actor: human(nullNameUser.id)}),
				Effect.provideService(RuntimeContext, runtimeContextStub),
			);

		assert.isDefined(captured);
		assert.strictEqual(captured?.authorName, "kullanıcı");
		assert.notStrictEqual(captured?.authorName, nullNameUser.email);
		assert.notInclude(captured?.authorName ?? "", "@");
	}),
);
