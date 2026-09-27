/**
 * `SpellSet`: the registry table and the key bindings compiled against it, in one cell.
 *
 * The claim under test is that the two are one value and not two pieces of state kept in step —
 * every write recompiles, every read returns both halves of one config, and the `SpellRegistry` the
 * same layer hands out reads that same cell rather than a second one. `reload-proof.unit.test.ts`
 * watches a real boot across a real config reload; this file drives the module directly, including
 * the narrower `swap` entry that no config path reaches. `spell-set.unit.test.ts` (#7752) pins the
 * generation and race properties on its own fixtures; this file reads the compiled config.
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Schema} from "effect";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {spells} from "./bindings/fixtures.ts";
import type {BindingSource} from "./bindings/index.ts";
import {SpellNotFound} from "./errors.ts";
import {buildRegistry, SpellRegistry} from "./registry.ts";
import {type AnySpell, defineSpell, renderPath} from "./spell.ts";
import {SpellSet, type SpellSetInput} from "./spell-set.ts";

type State = {readonly ticks: number};
type Msg = {readonly type: "tick"};

const talker = ProgramId.make("talker");

const echo = defineSpell({
	path: ["echo"],
	describe: "Answer with the word it was given.",
	params: Schema.Struct({word: Schema.String}),
	result: Schema.Struct({word: Schema.String}),
	execute: (args: {readonly word: string}) => Effect.succeed(args),
	capabilities: [],
});

const program = (list: ReadonlyArray<AnySpell>): AnyProgram =>
	({
		id: talker,
		core: defineMachine<State, Msg, never, never, unknown>({
			init: (loaded) => [loaded ?? {ticks: 0}, []],
			update: {tick: (state) => [{ticks: state.ticks + 1}, []]},
		}),
		ports: {},
		handlers: {},
		spells: list,
		capabilities: [],
		identity: {
			package: "@kampus/tuval",
			program: "talker",
			version: "1.0.0",
			digest: "sha256:talker",
		},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, never, never, unknown, never, never>;

const source = (file: string, bindings: Readonly<Record<string, string>>): BindingSource => ({
	file,
	bindings,
});

/** One config: the fixture spells, a program that declares `echo`, and one layer of key bindings. */
const config: SpellSetInput = {
	core: spells,
	programs: [program([echo])],
	keys: [
		source("global", {
			"ctrl-c": "window close",
			"ctrl-g": "window grow 3",
			"ctrl-e": "talker echo hello",
		}),
	],
};

const on = <A, E>(input: SpellSetInput, body: Effect.Effect<A, E, SpellSet | SpellRegistry>) =>
	body.pipe(Effect.provide(Layer.orDie(SpellSet.layer(input))));

const keysOf = (state: {readonly bindings: {readonly bindings: ReadonlyArray<{key: string}>}}) =>
	state.bindings.bindings.map((binding) => binding.key);

describe("SpellSet", () => {
	it.effect("hands back the table, its key sources and their compiled bindings as one value", () =>
		on(
			config,
			Effect.gen(function* () {
				const state = yield* SpellSet.use((set) => set.read);

				assert.includeMembers(
					state.table.rows.map((row) => renderPath(row.path)),
					["window.close", "window.grow", "talker.echo"],
					"a program's spell is not pathed under its program id",
				);
				assert.deepStrictEqual(
					state.keys.map((held) => held.file),
					["global"],
					"the state does not carry the sources its bindings were compiled from",
				);
				assert.deepStrictEqual(state.bindings.errors, []);
				assert.deepStrictEqual(keysOf(state).sort(), ["ctrl-c", "ctrl-e", "ctrl-g"]);

				// Decoded against the spell's own `params`, not carried as the token text a config
				// author wrote: `window grow 3` reaches a key router as the number 3.
				const grow = state.bindings.bindings.find((binding) => binding.key === "ctrl-g");
				assert.deepStrictEqual(grow?.args, {columns: 3});
			}),
		),
	);

	it.effect("costs a binding that does not compile its own key and nothing else", () =>
		on(
			{...config, keys: [source("global", {"ctrl-c": "window close", "ctrl-x": "window vanish"})]},
			Effect.gen(function* () {
				const state = yield* SpellSet.use((set) => set.read);

				assert.deepStrictEqual(keysOf(state), ["ctrl-c"]);
				assert.strictEqual(state.bindings.errors.length, 1);
				assert.strictEqual(state.bindings.errors[0]?.key, "ctrl-x");
				assert.strictEqual(state.bindings.errors[0]?.file, "global");
			}),
		),
	);

	it.effect(
		"keeps every layer's bindings, in layer order, so a later layer wins a shared key",
		() =>
			on(
				{
					...config,
					keys: [
						source("global", {"ctrl-c": "window close"}),
						source("project", {"ctrl-c": "workspace next"}),
					],
				},
				Effect.gen(function* () {
					const state = yield* SpellSet.use((set) => set.read);
					assert.deepStrictEqual(
						state.bindings.bindings.map((binding) => [binding.key, renderPath(binding.path)]),
						[
							["ctrl-c", "window.close"],
							["ctrl-c", "workspace.next"],
						],
						"the layers' bindings are not in layer order",
					);
				}),
			),
	);

	it.effect("installs a reloaded table and its freshly compiled bindings in one read's worth", () =>
		on(
			config,
			Effect.gen(function* () {
				const set = yield* SpellSet;
				yield* set.reload({
					core: spells,
					programs: [program([])],
					keys: config.keys,
				});
				const state = yield* SpellSet.use((held) => held.read);

				assert.notInclude(
					state.table.rows.map((row) => renderPath(row.path)),
					"talker.echo",
					"the reloaded table still holds the spell the program stopped declaring",
				);
				// The recompile is the point: the binding for the spell that went away is an error in
				// the same read that shows the table without it.
				assert.deepStrictEqual(keysOf(state).sort(), ["ctrl-c", "ctrl-g"]);
				assert.deepStrictEqual(
					state.bindings.errors.map((error) => error.key),
					["ctrl-e"],
					"the reload left a binding compiled against the table it replaced",
				);
			}),
		),
	);

	it.effect("recompiles the bindings on the registry's own swap, not only on a reload", () =>
		on(
			config,
			Effect.gen(function* () {
				const registry = yield* SpellRegistry;
				yield* registry.swap(yield* buildRegistry({core: spells, programs: []}).pipe(Effect.orDie));
				const state = yield* SpellSet.use((set) => set.read);

				assert.deepStrictEqual(keysOf(state).sort(), ["ctrl-c", "ctrl-g"]);
				assert.deepStrictEqual(
					state.bindings.errors.map((error) => error.key),
					["ctrl-e"],
					"the narrower swap entry left the two halves disagreeing",
				);
			}),
		),
	);

	it.effect("serves the registry off the same cell the set reads", () =>
		on(
			config,
			Effect.gen(function* () {
				const set = yield* SpellSet;
				const registry = yield* SpellRegistry;

				const row = yield* registry.lookup(["talker", "echo"]);
				assert.strictEqual(renderPath(row.path), "talker.echo");

				yield* set.reload({core: spells, programs: [program([])], keys: config.keys});

				const gone = yield* Effect.flip(registry.lookup(["talker", "echo"]));
				assert.instanceOf(gone, SpellNotFound);
				assert.strictEqual(gone.path, "talker.echo");
				assert.notInclude(
					(yield* registry.list).map((held) => renderPath(held.path)),
					"talker.echo",
					"the registry is reading a cell of its own",
				);
				assert.notInclude(
					(yield* registry.describe).map((held) => held.path.join(".")),
					"talker.echo",
				);
			}),
		),
	);
});
