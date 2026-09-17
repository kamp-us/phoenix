/**
 * The backward-compatibility proof for ADR 0395: the graph this desk actually boots
 * (`../../.tuval/tuval.config.ts`) compiles to exactly the routes it compiled to before a route
 * was decided by payload fit. Written as the accepted route set rather than "it did not throw",
 * because a rule that quietly dropped a route would still not throw.
 *
 * The shipped rows are hand-written ones that publish no payload schema, so every route here takes
 * the nominal clause of the rule — which is the point: the change is invisible to them. The
 * ai-agent graph's own proof (`../ai-agent/ai-agent-ports.unit.test.ts`) covers the rows that do
 * publish schemas on their one-way ports.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import shipped from "../../.tuval/tuval.config.ts";
import {Registry} from "../registry/Registry.ts";
import {compile} from "./compile.ts";

describe("the shipped project graph", () => {
	it.effect("compiles to the same routes a nominal check accepted", () =>
		Effect.gen(function* () {
			const compiled = yield* Effect.provide(
				compile(shipped.graph ?? {nodes: []}),
				Registry.layer(shipped.programs),
			);
			assert.deepStrictEqual(compiled.routes, [
				{
					kind: "count/v1",
					source: {node: "counter", port: "ticks", program: "counter"},
					target: {node: "log", port: "ticks", program: "log"},
				},
			]);
			assert.deepStrictEqual(
				compiled.nodes.map((node) => node.id),
				["shell", "counter", "log"],
			);
		}),
	);
});
