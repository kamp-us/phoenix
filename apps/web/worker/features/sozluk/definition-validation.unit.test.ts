/**
 * Definition-body validation driven THROUGH its only caller, the mutation, not the extracted
 * helper in isolation. `addDefinition` / `editDefinition` run `validateBody` BEFORE any DB
 * read, so a throwing `Drizzle` is the proof: a refactor that reorders the call after a read,
 * or drops it, dies here instead of rejecting.
 *
 * The DB-state-dependent rejections of the same mutations stay on real D1 in
 * `tests/integration/sozluk-mutations.test.ts`.
 */

import {it} from "@effect/vitest";
import {Cause, type Context, Effect, Exit, Layer} from "effect";
import {assert} from "vitest";
import {Drizzle, type DrizzleAccess} from "../../db/Drizzle.ts";
import {DefinitionId, TermSlug, UserId} from "../../lib/ids.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {Reaction} from "../reaction/Reaction.ts";
import {Vote} from "../vote/Vote.ts";
import {DEFINITION_BODY_MAX, Sozluk, SozlukLive} from "./Sozluk.ts";

// Every DB call dies, so any path that reaches the seam fails the test: running to a typed
// failure against this access is the "no DB call" proof.
const throwingAccess: DrizzleAccess = {
	run: () =>
		Effect.die(new Error("a sozluk mutation read the DB on a path that must short-circuit")),
	batch: () =>
		Effect.die(new Error("a sozluk mutation wrote a batch on a path that must short-circuit")),
};

// Sozluk's validation gate doesn't touch Vote, so an inert never-cast instance satisfies the
// layer's dependency type.
const inertVote = Layer.succeed(Vote, {} as Context.Service.Shape<typeof Vote>);
const inertReaction = Layer.succeed(Reaction, {} as Context.Service.Shape<typeof Reaction>);
const inertPasaport = Layer.succeed(Pasaport, {} as Context.Service.Shape<typeof Pasaport>);

const sozlukLayer = SozlukLive.pipe(
	Layer.provide(Layer.succeed(Drizzle, throwingAccess)),
	Layer.provide(inertVote),
	Layer.provide(inertReaction),
	Layer.provide(inertPasaport),
);

const expectTag = (exit: Exit.Exit<unknown, unknown>, tag: string) => {
	assert.isTrue(Exit.isFailure(exit), "expected the mutation to fail at the validation gate");
	if (Exit.isFailure(exit)) {
		const error = Cause.findErrorOption(exit.cause);
		assert.isTrue(
			error._tag === "Some",
			"expected a typed validation failure, not a die (a DB call)",
		);
		if (error._tag === "Some") {
			assert.strictEqual((error.value as {_tag: string})._tag, tag);
		}
	}
};

const ownerId = UserId.make("u1");

const runAdd = (body: string | undefined) =>
	Effect.gen(function* () {
		const sozluk = yield* Sozluk;
		return yield* sozluk
			.addDefinition({
				termSlug: TermSlug.make("fate"),
				authorId: ownerId,
				authorName: "umut",
				body: body as string,
			})
			.pipe(Effect.exit);
	}).pipe(Effect.provide(sozlukLayer));

const runEdit = (body: string | undefined) =>
	Effect.gen(function* () {
		const sozluk = yield* Sozluk;
		return yield* sozluk
			.editDefinition({
				definitionId: DefinitionId.make("def_1"),
				actorId: ownerId,
				body: body as string,
			})
			.pipe(Effect.exit);
	}).pipe(Effect.provide(sozlukLayer));

it.effect("addDefinition: an undefined body rejects with BodyRequired before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runAdd(undefined), "sozluk/BodyRequired");
	}),
);

it.effect(
	"addDefinition: a whitespace-only body rejects with BodyRequired before any DB call",
	() =>
		Effect.gen(function* () {
			expectTag(yield* runAdd("   "), "sozluk/BodyRequired");
		}),
);

it.effect("addDefinition: an over-long body rejects with BodyTooLong before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runAdd("a".repeat(DEFINITION_BODY_MAX + 1)), "sozluk/BodyTooLong");
	}),
);

it.effect("editDefinition: an undefined body rejects with BodyRequired before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runEdit(undefined), "sozluk/BodyRequired");
	}),
);

it.effect(
	"editDefinition: a whitespace-only body rejects with BodyRequired before any DB call",
	() =>
		Effect.gen(function* () {
			expectTag(yield* runEdit("   "), "sozluk/BodyRequired");
		}),
);

it.effect("editDefinition: an over-long body rejects with BodyTooLong before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runEdit("a".repeat(DEFINITION_BODY_MAX + 1)), "sozluk/BodyTooLong");
	}),
);
