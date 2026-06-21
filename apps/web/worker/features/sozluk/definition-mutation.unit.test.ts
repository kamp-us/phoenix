/**
 * `definition.add` ROUTING-boundary unit coverage (ADR 0039 / 0082) — the one
 * thing that is wrong-or-right with no database: does the resolver in
 * `mutations.ts` publish the new node to the term's **args-scoped**
 * `Term.definitions` topic (`{id: termSlug}`), or does it leak to the
 * procedure-wide global wildcard?
 *
 * This drives the REAL resolver (`mutations["definition.add"].handler`) over a
 * stub `Sozluk` and a recording `LivePublisher` — the same handler-over-stubs
 * seam `report/report-mutation.unit.test.ts` and `pano/draft-save.invariant.test.ts`
 * use. The resolver owns the `live.topic("Term.definitions", {id:
 * input.termSlug})` call; if it ever dropped the args (→ wildcard, the ADR 0039
 * mis-route), the recorded topic key is the global one and this test fails. The
 * publisher's key-MATH (the `(procedure, args)` → topic computation) is pinned
 * exhaustively against literal fixtures in
 * `../fate-live/live-publisher.unit.test.ts`; this asserts the resolver's routing
 * CHOICE — the contract that file's two deleted cases pretended to test by
 * re-spelling the publisher call inline (never crossing the resolver).
 */

import {assert, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {liveConnectionTopic, liveGlobalConnectionTopic} from "@nkzw/fate/server";
import {Effect, Layer} from "effect";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {mutations} from "./mutations.ts";
import type {AddDefinitionResult} from "./Sozluk.ts";
import {Sozluk} from "./Sozluk.ts";

const AUTHOR = {id: "u-author", email: "yazar@example.com", name: "yazar"};

// A `Sozluk` stub whose `addDefinition` is scripted; every other method dies on
// contact, so a passing test proves `definition.add` reached only the write it
// routes around. Mirrors `draft-save.invariant.test.ts`'s `panoStub`.
const sozlukStub = (result: AddDefinitionResult): Layer.Layer<Sozluk> =>
	Layer.succeed(
		Sozluk,
		new Proxy({addDefinition: () => Effect.succeed(result)} as Partial<typeof Sozluk.Service>, {
			get(target, prop) {
				if (prop in target) return (target as Record<string, unknown>)[prop as string];
				return () => Effect.die(`Sozluk.${String(prop)} not exercised in definition-mutation`);
			},
		}) as typeof Sozluk.Service,
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

			// A recording `LivePublisher`: `publish` captures the topic key the resolver's
			// `live.*` chose, `waitUntil` collects the fire-and-forget work so `flush`
			// drains it (the publish is detached off the request path).
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
				.handler({input: {termSlug: slug, body: ADD_RESULT.body}, select: ["id"]})
				.pipe(
					Effect.provide(Layer.mergeAll(sozlukStub(ADD_RESULT), liveStub)),
					Effect.provideService(CurrentUser, {user: AUTHOR}),
				);
			yield* Effect.promise(() => Promise.allSettled(scheduled));

			// The contract: the resolver routes the new node to the term's args-scoped
			// connection topic (keyed by `{id: slug}`), so only that term's open page
			// updates live.
			assert.deepStrictEqual(recorded, [liveConnectionTopic("Term.definitions", {id: slug})]);
			// The ADR 0039 mis-route guard: a regression where the resolver called
			// `topic("Term.definitions")` with NO args would land on the
			// procedure-wide global wildcard (fanning one term's definition out to every
			// `Term.definitions` subscriber across all slugs). That topic must be absent.
			assert.isFalse(recorded.includes(liveGlobalConnectionTopic("Term.definitions")));
		}),
);
