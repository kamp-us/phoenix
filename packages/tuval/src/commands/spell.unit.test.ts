/**
 * What `defineSpell` refuses is a type-level fact, so `tsc` over this file is the proof: the
 * `@ts-expect-error` directives below would themselves fail as unused (TS2578) if the shape ever
 * widened. Beside them, the vocabulary check the slice owes — no product name in any identifier.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {assert, describe, expect, expectTypeOf, it} from "@effect/vitest";
import {Effect, Schema} from "effect";
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

	it.effect("is the identity function — the value it returns is the value it was given", () =>
		Effect.gen(function* () {
			const spell = {
				path: ["window", "close"],
				describe: "Close the focused window.",
				params: Schema.Struct({id: Schema.String}),
				result: Schema.Struct({closed: Schema.Boolean}),
				execute: () => Effect.succeed({closed: true}),
				capabilities: [],
			} as const;
			assert.strictEqual(defineSpell(spell), spell);
			assert.deepStrictEqual(yield* closeWindow.execute({id: "w1"}, scope), {closed: true});
		}),
	);

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
	// Recursive: `bindings/`, `bridge/`, `core/` and `parse/` are most of the slice, and a check
	// that scanned only the top level would leave them unchecked.
	const modulesUnder = (dir: string, prefix = ""): ReadonlyArray<readonly [string, string]> =>
		readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return modulesUnder(path, `${prefix}${entry.name}/`);
			if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
			return [[`${prefix}${entry.name}`, readFileSync(path, "utf8")] as const];
		});

	const modules = modulesUnder(import.meta.dirname);

	const withoutProse = (source: string): string =>
		source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "")
			.replace(/"(?:[^"\\]|\\.)*"/g, '""');

	it("scans every module of the slice, nested directories included", () => {
		// Derived, not pinned: a new module must not red this guard, but the floor keeps it from
		// silently scanning nothing, and each subdirectory is named so a lost one shows up.
		const names = modules.map(([name]) => name);
		expect(names).toEqual(
			expect.arrayContaining([
				"errors.ts",
				"executor.ts",
				"registry.ts",
				"spell.ts",
				"bindings/compile.ts",
				"bridge/SpellBridge.ts",
				"core/help.ts",
				"parse/reading.ts",
			]),
		);
		expect(names.filter((name) => name.endsWith(".test.ts"))).toEqual([]);
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
		// span convention (`.patterns/effect-fn-tracing.md`); `@kampus/tuval` is this workspace
		// package's own name. All three are required, none is an identifier, and there is no fourth.
		const sanctioned = /^(tuval\/[A-Za-z/]+|Tuval(\.[A-Za-z]+)+|@kampus\/tuval)$/;
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
