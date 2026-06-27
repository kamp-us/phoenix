/**
 * `CurrentActorLive` derivation (ADR 0107 §5): anonymous session → `Unauthenticated`,
 * a signed-in account → `Human` keyed by its id, NEVER an `Agent` (v1 humans-only).
 * `currentActorContext` packages that actor into the per-request `CurrentActor`
 * value the fate-effect seam fulfills.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentActor} from "@kampus/authz";
import type {CurrentUserInfo} from "@kampus/fate-effect";
import {Context} from "effect";
import {currentActorContext, currentActorOf} from "./CurrentActorLive.ts";

const user: CurrentUserInfo = {id: "u1", email: "u1@test.local", name: "U One"};

describe("currentActorOf", () => {
	it("derives Unauthenticated from an anonymous session", () => {
		assert.deepStrictEqual(currentActorOf(undefined), {_tag: "Unauthenticated"});
	});

	it("derives a Human keyed by account id from a signed-in session", () => {
		assert.deepStrictEqual(currentActorOf(user), {
			_tag: "Authenticated",
			principal: {_tag: "Human", id: "u1"},
		});
	});
});

describe("currentActorContext", () => {
	it("packages the derived actor into the CurrentActor request value", () => {
		const {actor} = Context.get(currentActorContext(user), CurrentActor);
		assert.deepStrictEqual(actor, {
			_tag: "Authenticated",
			principal: {_tag: "Human", id: "u1"},
		});
	});
});
