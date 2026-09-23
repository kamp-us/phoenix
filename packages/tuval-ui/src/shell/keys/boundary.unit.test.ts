/**
 * The two boundaries this slice keeps: a binding is plain data nothing callable can enter
 * (type-level, so `tsc` over this file is the proof), and nothing here listens to the host —
 * no `document`, no global, no subscription. Owning the listener is the shell host's job.
 */

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {Duration} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {PrefixState, RouteAnswer} from "./router.ts";
import type {Binding, CommandName, KeysConfig, PrefixTable} from "./table.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

const sources = readdirSync(here).filter(
	(name) => name.endsWith(".ts") && !name.endsWith(".unit.test.ts"),
);

describe("keys boundary", () => {
	it("a binding is plain data: three fields, none of them callable", () => {
		expectTypeOf<keyof Binding>().toEqualTypeOf<"sequence" | "command" | "repeatable">();
		expectTypeOf<Binding["sequence"]>().toEqualTypeOf<string>();
		expectTypeOf<Binding["command"]>().toEqualTypeOf<CommandName>();
		expectTypeOf<Binding["repeatable"]>().toEqualTypeOf<boolean>();
		// A command is named, never carried: `CommandName` is a branded string, so no function fits.
		expectTypeOf<Binding["command"]>().not.toBeFunction();
		expectTypeOf<Binding>().not.toBeFunction();

		const handler: Binding = {
			sequence: "x",
			// @ts-expect-error a handler cannot stand in for a command name
			command: () => "window:close",
			repeatable: false,
		};
		const smuggled: Binding = {
			sequence: "x",
			command: "window:close" as CommandName,
			repeatable: false,
			// @ts-expect-error and no extra field can smuggle one in beside the name
			run: () => {},
		};
		expect([handler, smuggled]).toHaveLength(2);
	});

	// The key set is the fence: an armed prefix waits indefinitely (#7842), so a table with nowhere
	// to put an arm timeout is what stops any config reintroducing one.
	it("the table is plain data too: one duration, the repeat window, and a list of bindings", () => {
		expectTypeOf<keyof PrefixTable>().toEqualTypeOf<"prefix" | "repeatTimeout" | "bindings">();
		expectTypeOf<PrefixTable["repeatTimeout"]>().toEqualTypeOf<Duration.Duration>();
		expectTypeOf<PrefixTable["bindings"]>().toEqualTypeOf<ReadonlyArray<Binding>>();
	});

	it("a user config has nowhere to put an arm timeout either", () => {
		expectTypeOf<keyof KeysConfig>().toEqualTypeOf<"prefix" | "repeatTimeout" | "bindings">();
	});

	it("every answer carries the state that follows it", () => {
		expectTypeOf<RouteAnswer["_tag"]>().toEqualTypeOf<
			"ToWindow" | "Arm" | "Command" | "Pending" | "Unbound"
		>();
		expectTypeOf<RouteAnswer["next"]>().toEqualTypeOf<PrefixState>();
	});

	it("reads no host: no document, no global listener, no timer", () => {
		expect(sources.length).toBeGreaterThan(0);
		for (const name of sources) {
			// Comments go first: "window" is this slice's own domain noun, so only code counts.
			const code = readFileSync(`${here}${name}`, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "");
			for (const forbidden of [
				"document",
				"addEventListener",
				"globalThis",
				"window.",
				"setTimeout",
				"setInterval",
				"queueMicrotask",
			]) {
				expect(`${name}: ${code.includes(forbidden)}`).toBe(`${name}: false`);
			}
		}
	});
});
