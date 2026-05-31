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

import {expectTypeOf, it} from "vitest";
import {liveBus} from "./event-bus.ts";
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
