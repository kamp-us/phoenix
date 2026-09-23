import {type Cmd, defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Schema} from "effect";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {DuplicateSpellPath, SpellNotDescribable, SpellNotFound} from "./errors.ts";
import {buildRegistry, type RegistryTable, SpellRegistry} from "./registry.ts";
import {type AnySpell, defineSpell, renderPath, type SpellPath} from "./spell.ts";

type State = {readonly count: number};
type Msg = {readonly type: "tick"};

const machine = defineMachine<State, Msg, Cmd<never>, never, unknown>({
	init: (loaded) => [loaded ?? {count: 0}, []],
	update: {tick: (state) => [{count: state.count + 1}, []]},
});

const spell = (path: SpellPath, describe = `Run ${renderPath(path)}.`): AnySpell =>
	defineSpell({
		path,
		describe,
		params: Schema.Struct({id: Schema.String}),
		result: Schema.Struct({ok: Schema.Boolean}),
		execute: () => Effect.succeed({ok: true}),
		capabilities: [{family: "process-control"}],
	});

const program = (id: string, spells: ReadonlyArray<AnySpell>): AnyProgram =>
	({
		id: ProgramId.make(id),
		core: machine,
		ports: {},
		handlers: {},
		spells,
		capabilities: [],
		identity: {package: "@kampus/tuval", program: id, version: "1.0.0", digest: `sha256:${id}`},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, Cmd<never>, never, unknown, never, never>;

const paths = (table: RegistryTable): ReadonlyArray<string> =>
	table.rows.map((row) => renderPath(row.path));

const build = (input: Parameters<typeof buildRegistry>[0]) => buildRegistry(input);

const refusal = (input: Parameters<typeof buildRegistry>[0]) => Effect.flip(buildRegistry(input));

const withRegistry = <A, E>(
	table: RegistryTable,
	body: (registry: SpellRegistry["Service"]) => Effect.Effect<A, E>,
) => Effect.flatMap(SpellRegistry, body).pipe(Effect.provide(SpellRegistry.layer(table)));

describe("buildRegistry", () => {
	it.effect("places core spells at their path and each program's spells under its id", () =>
		Effect.gen(function* () {
			const table = yield* build({
				core: [spell(["window", "close"]), spell(["quit"])],
				programs: [
					program("editor", [spell(["save"]), spell(["buffer", "next"])]),
					program("terminal", [spell(["save"])]),
				],
			});
			assert.deepStrictEqual(paths(table), [
				"window.close",
				"quit",
				"editor.save",
				"editor.buffer.next",
				"terminal.save",
			]);
			assert.deepStrictEqual(
				table.rows.map((row) => row.source),
				[
					{kind: "core"},
					{kind: "core"},
					{kind: "program", programId: "editor"},
					{kind: "program", programId: "editor"},
					{kind: "program", programId: "terminal"},
				],
			);
		}),
	);

	it.effect("registers a program that declares no spells as contributing none", () =>
		Effect.gen(function* () {
			const table = yield* build({core: [], programs: [program("empty", [])]});
			assert.deepStrictEqual(paths(table), []);
		}),
	);

	it.effect("refuses a core path a program also claims, naming both sources", () =>
		Effect.gen(function* () {
			const error = yield* refusal({
				core: [spell(["editor", "save"])],
				programs: [program("editor", [spell(["save"])])],
			});
			assert.instanceOf(error, DuplicateSpellPath);
			assert.strictEqual(error.path, "editor.save");
			assert.strictEqual(error.first, "the core spell list");
			assert.strictEqual(error.second, 'program "editor"');
			assert.strictEqual(
				error.message,
				'spell path "editor.save" is already registered by the core spell list; refusing program "editor"',
			);
		}),
	);

	it.effect("registers a program whose `spells` field is absent as contributing none", () =>
		Effect.gen(function* () {
			const {spells: _spells, ...withoutSpells} = program("empty", []);
			const table = yield* build({core: [], programs: [withoutSpells as AnyProgram]});
			assert.deepStrictEqual(paths(table), []);
		}),
	);

	it.effect(
		"refuses a spell whose params no JSON Schema can describe, naming the spell and its source",
		() =>
			Effect.gen(function* () {
				// A number-keyed record has no JSON Schema form at the pin: `toJsonSchemaDocument` throws on
				// its index signature. Registering it would defect `describe`, and with it `help`, `spell
				// list` and every `Snapshot`.
				const unrepresentable = defineSpell({
					path: ["window", "sizes"],
					describe: "Report the size of every window.",
					params: Schema.Record(Schema.Number, Schema.String),
					result: Schema.Struct({ok: Schema.Boolean}),
					execute: () => Effect.succeed({ok: true}),
					capabilities: [],
				});

				const fromCore = yield* refusal({core: [unrepresentable], programs: []});
				assert.instanceOf(fromCore, SpellNotDescribable);
				assert.strictEqual(fromCore.path, "window.sizes");
				assert.strictEqual(fromCore.source, "the core spell list");
				assert.include(fromCore.message, 'spell "window.sizes" from the core spell list');

				const fromProgram = yield* refusal({
					core: [],
					programs: [program("editor", [unrepresentable])],
				});
				assert.instanceOf(fromProgram, SpellNotDescribable);
				assert.strictEqual(fromProgram.path, "editor.window.sizes");
				assert.strictEqual(fromProgram.source, 'program "editor"');
			}),
	);

	it.effect("describes every registered spell without throwing, from the row's own document", () =>
		Effect.gen(function* () {
			const table = yield* build({core: [spell(["window", "close"])], programs: []});
			const described = yield* withRegistry(table, (registry) => registry.describe);
			assert.deepStrictEqual(described, [
				{
					path: ["window", "close"],
					describe: "Run window.close.",
					params: Schema.toJsonSchemaDocument(Schema.Struct({id: Schema.String})),
					capabilities: [{family: "process-control"}],
				},
			]);
		}),
	);

	it.effect("refuses one program claiming a path twice, naming both sources", () =>
		Effect.gen(function* () {
			const error = yield* refusal({
				core: [],
				programs: [program("editor", [spell(["save"]), spell(["save"], "Save again.")])],
			});
			assert.instanceOf(error, DuplicateSpellPath);
			assert.strictEqual(
				error.message,
				'spell path "editor.save" is already registered by program "editor"; refusing program "editor"',
			);
		}),
	);
});

describe("SpellRegistry", () => {
	it.effect("looks a spell up by its path and fails an unregistered one with a typed error", () =>
		Effect.gen(function* () {
			const table = yield* build({
				core: [spell(["window", "close"])],
				programs: [program("editor", [spell(["save"])])],
			});
			const [core, fromProgram, missing, partial] = yield* withRegistry(table, (registry) =>
				Effect.all(
					[
						registry.lookup(["window", "close"]),
						registry.lookup(["editor", "save"]),
						Effect.flip(registry.lookup(["window", "open"])),
						Effect.flip(registry.lookup(["window"])),
					],
					{concurrency: "unbounded"},
				),
			);
			assert.strictEqual(renderPath(core.path), "window.close");
			assert.strictEqual(renderPath(fromProgram.path), "editor.save");
			assert.instanceOf(missing, SpellNotFound);
			assert.strictEqual(missing.message, 'no spell is registered at path "window.open"');
			// `window` is an interior node of the trie: it routes to `window.close` and holds no spell.
			assert.instanceOf(partial, SpellNotFound);
		}),
	);

	it.effect("replaces the whole table in one write — a concurrent reader never sees a mix", () =>
		Effect.gen(function* () {
			const before = yield* build({core: [spell(["a"]), spell(["b"])], programs: []});
			const after = yield* build({
				core: [spell(["c"])],
				programs: [program("editor", [spell(["d"]), spell(["e"])])],
			});
			const seen = yield* withRegistry(before, (registry) =>
				Effect.gen(function* () {
					const observations: Array<ReadonlyArray<string>> = [];
					const observe = Effect.gen(function* () {
						const rows = yield* registry.list;
						observations.push(rows.map((row) => renderPath(row.path)));
					});
					const read = Effect.gen(function* () {
						for (let round = 0; round < 200; round++) {
							yield* observe;
							yield* Effect.yieldNow;
						}
					});
					// The bracketing reads sit outside the race, so "first sees the old table, last sees
					// the new one" is true by sequencing rather than by how the scheduler happened to
					// interleave three fibers. `Effect.all` joins every fiber it forked, so the swap has
					// landed before the closing read runs.
					yield* observe;
					yield* Effect.all([read, read, registry.swap(after)], {concurrency: "unbounded"});
					yield* observe;
					return observations;
				}),
			);
			const [oldPaths, newPaths] = [paths(before), paths(after)];
			for (const observation of seen) {
				assert.deepInclude([oldPaths, newPaths], observation);
			}
			assert.deepStrictEqual(seen.at(0), oldPaths);
			assert.deepStrictEqual(seen.at(-1), newPaths);
		}),
	);

	it.effect("describes every spell as JSON that survives a stringify/parse round trip", () =>
		Effect.gen(function* () {
			const table = yield* build({
				core: [spell(["window", "close"])],
				programs: [program("editor", [spell(["save"])])],
			});
			const described = yield* withRegistry(table, (registry) => registry.describe);
			assert.deepStrictEqual(described, JSON.parse(JSON.stringify(described)));
			assert.deepStrictEqual(described, [
				{
					path: ["window", "close"],
					describe: "Run window.close.",
					params: {
						dialect: "draft-2020-12",
						schema: {
							type: "object",
							properties: {id: {type: "string"}},
							required: ["id"],
							additionalProperties: false,
						},
						definitions: {},
					},
					capabilities: [{family: "process-control"}],
				},
				{
					path: ["editor", "save"],
					describe: "Run save.",
					params: {
						dialect: "draft-2020-12",
						schema: {
							type: "object",
							properties: {id: {type: "string"}},
							required: ["id"],
							additionalProperties: false,
						},
						definitions: {},
					},
					capabilities: [{family: "process-control"}],
				},
			]);
		}),
	);

	it.effect("`scripted` builds the registry over a bare core list", () =>
		Effect.gen(function* () {
			const listed = yield* Effect.flatMap(SpellRegistry, (registry) => registry.list).pipe(
				Effect.provide(SpellRegistry.scripted([spell(["quit"])])),
			);
			assert.deepStrictEqual(
				listed.map((row) => renderPath(row.path)),
				["quit"],
			);
		}),
	);
});
