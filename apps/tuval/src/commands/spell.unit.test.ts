/**
 * What `defineSpell` refuses is a type-level fact, so `tsc` over this file is the proof: the
 * `@ts-expect-error` directives below would themselves fail as unused (TS2578) if the shape ever
 * widened. Beside them, the vocabulary check the slice owes — no product name in any identifier.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {Effect, Schema} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import {defineSpell, type Scope, type Spell} from "./spell.ts";

const scope: Scope = {
	workspace: "main" as Scope["workspace"],
	client: "cli" as Scope["client"],
};

const closeWindow = defineSpell({
	path: ["window", "close"],
	describe: "Close the focused window.",
	params: Schema.Struct({id: Schema.String}),
	result: Schema.Struct({closed: Schema.Boolean}),
	execute: (args) => Effect.succeed({closed: args.id.length > 0}),
	capabilities: [{family: "process-control"}],
});

const notASchema = {parse: (value: unknown): string => String(value)};

defineSpell({
	path: ["window", "raise"],
	describe: "Raise the focused window.",
	// @ts-expect-error `params` must be an Effect `Schema`; a bare parser object is refused
	params: notASchema,
	result: Schema.Boolean,
	execute: () => Effect.succeed(true),
	capabilities: [],
});

defineSpell({
	path: ["window", "lower"],
	describe: "Lower the focused window.",
	params: Schema.Struct({id: Schema.String}),
	result: Schema.Boolean,
	// @ts-expect-error `execute` returns an Effect; a Promise-returning body is refused
	execute: async () => true,
	capabilities: [],
});

describe("defineSpell", () => {
	it("pins the params, result, error and requirement types at the definition site", () => {
		expectTypeOf(closeWindow.execute).parameter(0).toEqualTypeOf<{readonly id: string}>();
		expectTypeOf(closeWindow.execute).parameter(1).toEqualTypeOf<Scope>();
		expectTypeOf(closeWindow.execute).returns.toEqualTypeOf<
			Effect.Effect<{readonly closed: boolean}, never, never>
		>();
	});

	it("is the identity function — the value it returns is the value it was given", async () => {
		expect(await Effect.runPromise(closeWindow.execute({id: "w1"}, scope))).toEqual({closed: true});
	});

	it("carries `capabilities` as inert data no part of this slice reads", () => {
		expectTypeOf<Spell<Schema.Top, Schema.Top, never, never>["capabilities"]>().toEqualTypeOf<
			ReadonlyArray<{
				readonly family:
					| "filesystem"
					| "network"
					| "process"
					| "model"
					| "github"
					| "process-control";
				readonly detail?: string;
			}>
		>();
	});
});

/**
 * The harness names the product to search for it, so it scans the slice's modules and not itself.
 * A tag string (`"tuval/SpellRegistry"`) is the repo's service-id convention, not an identifier, so
 * the code check runs over source with comments and string literals removed.
 */
describe("commands vocabulary", () => {
	const modules = readdirSync(import.meta.dirname)
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
		.map((name) => [name, readFileSync(join(import.meta.dirname, name), "utf8")] as const);

	const withoutProse = (source: string): string =>
		source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "")
			.replace(/"(?:[^"\\]|\\.)*"/g, '""');

	it("scans every module of the slice", () => {
		expect(modules.map(([name]) => name)).toEqual([
			"errors.ts",
			"executor.ts",
			"index.ts",
			"registry.ts",
			"scope.ts",
			"spell.ts",
		]);
	});

	it("names the product in no identifier — only in prose and in tag namespaces", () => {
		const offenders = modules
			.filter(([, source]) => /tuval/i.test(withoutProse(source)))
			.map(([name]) => name);
		expect(offenders).toEqual([]);
	});

	it("names the product in a string only as a service tag or a span, the two conventions", () => {
		// `tuval/<Name>` is the `Context.Service` / `Schema.TaggedError` id convention
		// (`.patterns/effect-context-service.md`); `Tuval.<Service>.<method>` is the `Effect.fn`
		// span convention (`.patterns/effect-fn-tracing.md`). Both are required, neither is an
		// identifier, and no third form is allowed.
		const sanctioned = /^(tuval\/[A-Za-z/]+|Tuval(\.[A-Za-z]+)+)$/;
		const offenders = modules.flatMap(([name, source]) =>
			[...source.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
				.map((match) => match[1] ?? "")
				.filter((literal) => /tuval/i.test(literal) && !sanctioned.test(literal))
				.map((literal) => `${name}: ${literal}`),
		);
		expect(offenders).toEqual([]);
	});

	it("uses no Turkish letter anywhere — the product name is the one Turkish noun and it has none", () => {
		const offenders = modules
			.filter(([, source]) => /[çğıİöşüÇĞÖŞÜ]/.test(source))
			.map(([name]) => name);
		expect(offenders).toEqual([]);
	});
});
