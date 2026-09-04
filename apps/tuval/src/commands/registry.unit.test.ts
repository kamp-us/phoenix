import {type Cmd, defineMachine} from "@demlik/tea";
import {Effect, Schema} from "effect";
import {describe, expect, it} from "vitest";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {DuplicateSpellPath, SpellNotFound} from "./errors.ts";
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

const build = (input: Parameters<typeof buildRegistry>[0]) =>
	Effect.runPromise(buildRegistry(input));

const refusal = (input: Parameters<typeof buildRegistry>[0]) =>
	Effect.runPromise(Effect.flip(buildRegistry(input)));

const withRegistry = <A, E>(
	table: RegistryTable,
	body: (registry: SpellRegistry["Service"]) => Effect.Effect<A, E>,
) =>
	Effect.runPromise(
		Effect.flatMap(SpellRegistry, body).pipe(Effect.provide(SpellRegistry.layer(table))),
	);

describe("buildRegistry", () => {
	it("places core spells at their path and each program's spells under its id", async () => {
		const table = await build({
			core: [spell(["window", "close"]), spell(["quit"])],
			programs: [
				program("editor", [spell(["save"]), spell(["buffer", "next"])]),
				program("terminal", [spell(["save"])]),
			],
		});
		expect(paths(table)).toEqual([
			"window.close",
			"quit",
			"editor.save",
			"editor.buffer.next",
			"terminal.save",
		]);
		expect(table.rows.map((row) => row.source)).toEqual([
			{kind: "core"},
			{kind: "core"},
			{kind: "program", programId: "editor"},
			{kind: "program", programId: "editor"},
			{kind: "program", programId: "terminal"},
		]);
	});

	it("registers a program that declares no spells as contributing none", async () => {
		const table = await build({core: [], programs: [program("empty", [])]});
		expect(paths(table)).toEqual([]);
	});

	it("refuses a core path a program also claims, naming both sources", async () => {
		const error = await refusal({
			core: [spell(["editor", "save"])],
			programs: [program("editor", [spell(["save"])])],
		});
		expect(error).toBeInstanceOf(DuplicateSpellPath);
		expect(error).toMatchObject({
			path: "editor.save",
			first: "the core spell list",
			second: 'program "editor"',
		});
		expect(error.message).toBe(
			'spell path "editor.save" is already registered by the core spell list; refusing program "editor"',
		);
	});

	it("refuses one program claiming a path twice, naming both sources", async () => {
		const error = await refusal({
			core: [],
			programs: [program("editor", [spell(["save"]), spell(["save"], "Save again.")])],
		});
		expect(error).toBeInstanceOf(DuplicateSpellPath);
		expect(error.message).toBe(
			'spell path "editor.save" is already registered by program "editor"; refusing program "editor"',
		);
	});
});

describe("SpellRegistry", () => {
	it("looks a spell up by its path and fails an unregistered one with a typed error", async () => {
		const table = await build({
			core: [spell(["window", "close"])],
			programs: [program("editor", [spell(["save"])])],
		});
		const [core, fromProgram, missing, partial] = await withRegistry(table, (registry) =>
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
		expect(renderPath(core.path)).toBe("window.close");
		expect(renderPath(fromProgram.path)).toBe("editor.save");
		expect(missing).toBeInstanceOf(SpellNotFound);
		expect(missing.message).toBe('no spell is registered at path "window.open"');
		// `window` is an interior node of the trie: it routes to `window.close` and holds no spell.
		expect(partial).toBeInstanceOf(SpellNotFound);
	});

	it("replaces the whole table in one write — a concurrent reader never sees a mix", async () => {
		const before = await build({core: [spell(["a"]), spell(["b"])], programs: []});
		const after = await build({
			core: [spell(["c"])],
			programs: [program("editor", [spell(["d"]), spell(["e"])])],
		});
		const seen = await withRegistry(before, (registry) => {
			const observations: Array<ReadonlyArray<string>> = [];
			const read = Effect.gen(function* () {
				for (let round = 0; round < 200; round++) {
					const rows = yield* registry.list;
					observations.push(rows.map((row) => renderPath(row.path)));
					yield* Effect.yieldNow;
				}
			});
			return Effect.as(
				Effect.all([read, read, registry.swap(after)], {concurrency: "unbounded"}),
				observations,
			);
		});
		const [oldPaths, newPaths] = [paths(before), paths(after)];
		for (const observation of seen) {
			expect([oldPaths, newPaths]).toContainEqual(observation);
		}
		expect(seen.at(0)).toEqual(oldPaths);
		expect(seen.at(-1)).toEqual(newPaths);
	});

	it("describes every spell as JSON that survives a stringify/parse round trip", async () => {
		const table = await build({
			core: [spell(["window", "close"])],
			programs: [program("editor", [spell(["save"])])],
		});
		const described = await withRegistry(table, (registry) => registry.describe);
		expect(described).toEqual(JSON.parse(JSON.stringify(described)));
		expect(described).toEqual([
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
	});

	it("`scripted` builds the registry over a bare core list", async () => {
		const listed = await Effect.runPromise(
			Effect.flatMap(SpellRegistry, (registry) => registry.list).pipe(
				Effect.provide(SpellRegistry.scripted([spell(["quit"])])),
			),
		);
		expect(listed.map((row) => renderPath(row.path))).toEqual(["quit"]);
	});
});
