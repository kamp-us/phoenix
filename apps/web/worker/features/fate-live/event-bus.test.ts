/**
 * `liveBus` connection-procedure typing — the connection analogue of the
 * `liveBus.update` entity-name gate.
 *
 * `liveBus.connection(<procedure>)` keys a topic off its procedure string, and
 * the matching subscribe keys off the same string; a typo on either side
 * silently creates a dead topic (publish and subscribe miss each other with no
 * failure). The `LiveConnectionProcedure` union closes that seam — a typo at a
 * call site is now a compile error. These are type-level assertions; the
 * `@ts-expect-error` lines are the gate (removing the typing makes them fail to
 * error and the build breaks).
 */

import {assert, it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import {expectTypeOf} from "vitest";
import {liveBus, liveBusFor} from "./event-bus.ts";
import type {LiveConnectionProcedure} from "./protocol.ts";

it("accepts every real connection procedure", () => {
	// The three live procedures actually published in the codebase
	// (`features/pano/mutations.ts`, `features/sozluk/mutations.ts`). These must
	// stay assignable — a regression that drops one breaks publishing for it.
	liveBus.connection("posts");
	liveBus.connection("Post.comments", {id: "p1"});
	liveBus.connection("Term.definitions", {id: "slug"});

	expectTypeOf<"posts">().toExtend<LiveConnectionProcedure>();
	expectTypeOf<"Post.comments">().toExtend<LiveConnectionProcedure>();
	expectTypeOf<"Term.definitions">().toExtend<LiveConnectionProcedure>();
});

it("rejects a typo'd connection procedure at the call site", () => {
	// @ts-expect-error a typo'd procedure is not a `LiveConnectionProcedure`.
	liveBus.connection("post");
	// @ts-expect-error a procedure outside the closed union is rejected.
	liveBus.connection("Term.defintions", {id: "slug"});
});

it.effect("useIgnore swallows a throwing publish — the mutation it follows can't fail", () =>
	// The void contract (ADR 0039) is the type (`Effect<void, never>`), but lock
	// the runtime half too: a publisher that throws (a failed DO fan-out) must be
	// swallowed, so a post-write publish can never fail the committed mutation.
	Effect.gen(function* () {
		let published = false;
		const live = liveBusFor(() => {
			published = true;
			throw new Error("DO unreachable");
		});

		const exit = yield* Effect.exit(live.useIgnore((bus) => bus.delete("Post", "p1")));

		assert.isTrue(published); // the publish actually fired (and threw)
		assert.isTrue(Exit.isSuccess(exit)); // ...yet useIgnore swallowed it to void
	}),
);
