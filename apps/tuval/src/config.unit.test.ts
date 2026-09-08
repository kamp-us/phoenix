import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {ConfigLoadError, loadConfigModule, loadLayeredConfig} from "./config.ts";
import {NodeId} from "./ports/graph.ts";
import {ProgramId} from "./registry/program.ts";

const fixture = (name: string) =>
	fileURLToPath(new URL(`./config-fixtures/${name}.ts`, import.meta.url));

/** How `describeFile` names a fixture module: relative to the directory two levels above it. */
const layerName = (name: string) => `config-fixtures/${name}.ts`;

const refusal = (name: string) =>
	Effect.map(Effect.flip(loadConfigModule(fixture(name))), (error) => {
		assert.instanceOf(error, ConfigLoadError);
		return error;
	});

const layered = (global: string, project: string) =>
	loadLayeredConfig({global, project}).pipe(Effect.provide(NodeFileSystem.layer));

describe("loadConfigModule", () => {
	it.effect(
		"returns the rows a well-formed module exports, and an empty graph when it exports none",
		() =>
			Effect.gen(function* () {
				const config = yield* loadConfigModule(fixture("two-rows"));
				assert.deepStrictEqual(config, {
					version: 1,
					features: {},
					programs: [{id: "a"}, {id: "b"}],
					graph: {nodes: []},
					keys: {},
				});
			}),
	);

	it.effect("returns the graph a module exports beside its rows", () =>
		Effect.gen(function* () {
			const config = yield* loadConfigModule(fixture("with-graph"));
			assert.deepStrictEqual(config, {
				version: 1,
				features: {},
				programs: [{id: "a"}],
				graph: {nodes: [{id: NodeId.make("n"), program: ProgramId.make("a"), on: []}]},
				keys: {},
			});
		}),
	);

	it.effect("refuses a graph that is not a graph, naming where and what it got", () =>
		Effect.gen(function* () {
			const error = yield* refusal("bad-graph");
			assert.strictEqual(error.reason, "not a v1 config at graph: Expected object");
		}),
	);

	it.effect("refuses a version the schema does not know", () =>
		Effect.gen(function* () {
			const error = yield* refusal("wrong-version");
			assert.strictEqual(error.reason, "not a v1 config at version: Expected 1");
		}),
	);

	it.effect("refuses a module that throws, naming the module and the thrown reason", () =>
		Effect.gen(function* () {
			const error = yield* refusal("throws");
			assert.strictEqual(error.module, fixture("throws"));
			assert.strictEqual(error.reason, "module threw while loading: boom at import time");
			assert.strictEqual(
				error.message,
				`config module ${fixture("throws")}: module threw while loading: boom at import time`,
			);
		}),
	);

	it.effect("refuses a default export that is not a v1 config, naming the missing key", () =>
		Effect.gen(function* () {
			const error = yield* refusal("wrong-shape");
			assert.strictEqual(error.module, fixture("wrong-shape"));
			assert.strictEqual(error.reason, "not a v1 config at version: Missing key");
		}),
	);

	it.effect("refuses a module with no default export", () =>
		Effect.gen(function* () {
			const error = yield* refusal("no-default");
			assert.strictEqual(error.module, fixture("no-default"));
			assert.strictEqual(
				error.reason,
				"no default export; export default a {version: 1, programs: [...]} config",
			);
		}),
	);
});

describe("the feature flags", () => {
	it.effect("are stated by nobody in a module that declares none", () =>
		Effect.gen(function* () {
			const config = yield* loadConfigModule(fixture("two-rows"));
			assert.deepStrictEqual(config.features, {});
		}),
	);

	it.effect("read back as the module wrote them", () =>
		Effect.gen(function* () {
			const config = yield* loadConfigModule(fixture("features-on"));
			assert.deepStrictEqual(config.features, {subagentList: true});
		}),
	);

	// A flag at a time, not a block at a time: a project layer that names one flag must not put every
	// flag the global layer turned on back to its default.
	it.effect("merge project over global one flag at a time", () =>
		Effect.gen(function* () {
			const merged = yield* layered(fixture("features-on"), fixture("two-rows"));
			assert.deepStrictEqual(merged.features, {subagentList: true, piSubagents: true});
		}),
	);

	// The direction that costs something: `subagentList` defaults on, so an operator turning it off
	// is a layer stating `false` over a `true` default, and a merge folding the layers the other way
	// round would silently ignore them.
	it.effect("let a layer that states a flag off win over the on default", () =>
		Effect.gen(function* () {
			const global = yield* layered(fixture("features-off"), fixture("two-rows"));
			assert.deepStrictEqual(global.features, {subagentList: false, piSubagents: true});
			const project = yield* layered(fixture("two-rows"), fixture("features-off"));
			assert.deepStrictEqual(project.features, {subagentList: false, piSubagents: true});
			const overGlobalOn = yield* layered(fixture("features-on"), fixture("features-off"));
			assert.deepStrictEqual(overGlobalOn.features, {subagentList: false, piSubagents: true});
		}),
	);
});

describe("loadLayeredConfig", () => {
	it.effect(
		"merges the project layer over the global one by program id and node id, global order first",
		() =>
			Effect.gen(function* () {
				const config = yield* layered(fixture("global-layer"), fixture("project-layer"));
				assert.deepStrictEqual(config, {
					programs: [{id: "a"}, {id: "b", core: "project"}],
					features: {subagentList: true, piSubagents: true},
					moduleRenderers: [],
					graph: {
						nodes: [
							{id: NodeId.make("n"), program: ProgramId.make("b"), on: []},
							{id: NodeId.make("m"), program: ProgramId.make("a"), on: []},
						],
					},
					keys: [
						{file: `global ${layerName("global-layer")}`, bindings: {}},
						{file: `project ${layerName("project-layer")}`, bindings: {}},
					],
					sources: [fixture("global-layer"), fixture("project-layer")],
				});
			}),
	);

	it.effect("treats an absent layer as empty and names only the layers it found", () =>
		Effect.gen(function* () {
			const missing = fixture("does-not-exist");
			assert.deepStrictEqual(yield* layered(missing, fixture("with-graph")), {
				programs: [{id: "a"}],
				features: {subagentList: true, piSubagents: true},
				moduleRenderers: [],
				graph: {nodes: [{id: NodeId.make("n"), program: ProgramId.make("a"), on: []}]},
				keys: [{file: `project ${layerName("with-graph")}`, bindings: {}}],
				sources: [fixture("with-graph")],
			});
			assert.deepStrictEqual(yield* layered(fixture("two-rows"), missing), {
				programs: [{id: "a"}, {id: "b"}],
				features: {subagentList: true, piSubagents: true},
				moduleRenderers: [],
				graph: {nodes: []},
				keys: [{file: `global ${layerName("two-rows")}`, bindings: {}}],
				sources: [fixture("two-rows")],
			});
			assert.deepStrictEqual(yield* layered(missing, missing), {
				programs: [],
				features: {subagentList: true, piSubagents: true},
				moduleRenderers: [],
				graph: {nodes: []},
				keys: [],
				sources: [],
			});
		}),
	);

	it.effect("carries each layer's key bindings as its own source, named for the layer", () =>
		Effect.gen(function* () {
			const config = yield* layered(fixture("keys"), fixture("does-not-exist"));
			assert.deepStrictEqual(config.keys, [
				{
					file: `global ${layerName("keys")}`,
					bindings: {"ctrl-h": "help", "ctrl-x": {command: "spell list", repeat: true}},
				},
			]);
		}),
	);

	it.effect(
		"names each module renderer beside the layer module that declared it, project origin winning",
		() =>
			Effect.gen(function* () {
				const global = fixture("module-renderer-global");
				const project = fixture("module-renderer-project");
				const config = yield* layered(global, project);
				assert.deepStrictEqual(config.moduleRenderers, [
					{ref: "@global/win/window", origin: global},
					// Row `b` is declared in both layers; the project row replaced the global one in
					// place, so the specifier resolves from the project config, not the global one.
					{ref: "@shared/win/window", origin: project},
					{ref: "@project/win/window", origin: project},
				]);
			}),
	);

	it.effect("still refuses a layer that exists and is broken", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				loadLayeredConfig({global: fixture("throws"), project: fixture("two-rows")}).pipe(
					Effect.provide(NodeFileSystem.layer),
				),
			);
			assert.instanceOf(error, ConfigLoadError);
			assert.strictEqual(error.module, fixture("throws"));
		}),
	);
});
