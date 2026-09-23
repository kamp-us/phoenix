/**
 * The two boundaries this slice keeps: a program's private Msg never reaches a port (type-level,
 * so `tsc` over this file is the proof), and nothing under `src/ports/` imports `src/process/`.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Cmd} from "@demlik/tea";
import type {Effect} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {Program} from "../registry/program.ts";
import type {PayloadRejected, PortNotWired} from "./errors.ts";
import type {Msg, State} from "./fixtures.ts";
import type {CompiledGraph, Graph} from "./graph.ts";
import type {Delivery, Wiring} from "./wiring.ts";

type OtherMsg = {readonly type: "shout"; readonly text: string};
type Row<M extends {readonly type: string}> = Program<
	State,
	M,
	Cmd<never>,
	never,
	unknown,
	never,
	never
>;

describe("ports boundary", () => {
	it("a program's private Msg is not reachable through any port", () => {
		// The ports facet of a row is invariant in Msg: swap the private vocabulary, nothing a
		// port exposes changes. Msg appears only in `core` and `handlers`.
		expectTypeOf<Row<Msg>["ports"]>().toEqualTypeOf<Row<OtherMsg>["ports"]>();
		// A port's payload is whatever its predicate admits, never a Msg: `accepts` narrows to
		// `unknown` at the row, so no port predicate can name the program's Msg.
		expectTypeOf<Row<Msg>["ports"][string]["accepts"]>().parameter(0).toEqualTypeOf<unknown>();
		// Neither the graph the author writes, the compiled graph, nor the wiring mentions a Msg:
		// every payload on the wire is `unknown` until a predicate admits it.
		expectTypeOf<Parameters<Wiring["emit"]>[1]>().toEqualTypeOf<unknown>();
		expectTypeOf<Wiring["emit"]>().returns.toEqualTypeOf<
			Effect.Effect<ReadonlyArray<Delivery>, PayloadRejected | PortNotWired>
		>();
		expectTypeOf<Graph>().not.toHaveProperty("core");
		expectTypeOf<CompiledGraph["nodes"][number]>().not.toHaveProperty("core");
		expectTypeOf<CompiledGraph["nodes"][number]>().not.toHaveProperty("handlers");
	});

	it("nothing in src/ports/ imports from src/process/", () => {
		const dir = import.meta.dirname;
		const offenders = readdirSync(dir)
			.filter((name) => name.endsWith(".ts"))
			.flatMap((name) => {
				const source = readFileSync(join(dir, name), "utf8");
				const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
				return specifiers.filter((s) => /(^|\/)process(\/|$)/.test(s)).map((s) => `${name}: ${s}`);
			});
		expect(offenders).toEqual([]);
	});
});
