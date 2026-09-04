import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {ConfigLoadError, loadConfigModule, loadLayeredConfig} from "./config.ts";

const fixture = (name: string) =>
	fileURLToPath(new URL(`./config-fixtures/${name}.ts`, import.meta.url));

/** How `describeFile` names a fixture module: relative to the directory two levels above it. */
const layerName = (name: string) => `config-fixtures/${name}.ts`;

const refusal = async (name: string): Promise<ConfigLoadError> => {
	const error = await Effect.runPromise(Effect.flip(loadConfigModule(fixture(name))));
	expect(error).toBeInstanceOf(ConfigLoadError);
	return error;
};

const layered = (global: string, project: string) =>
	Effect.runPromise(
		loadLayeredConfig({global, project}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

describe("loadConfigModule", () => {
	it("returns the rows a well-formed module exports, and an empty graph when it exports none", async () => {
		const config = await Effect.runPromise(loadConfigModule(fixture("two-rows")));
		expect(config).toEqual({
			version: 1,
			programs: [{id: "a"}, {id: "b"}],
			graph: {nodes: []},
			keys: {},
		});
	});

	it("returns the graph a module exports beside its rows", async () => {
		const config = await Effect.runPromise(loadConfigModule(fixture("with-graph")));
		expect(config).toEqual({
			version: 1,
			programs: [{id: "a"}],
			graph: {nodes: [{id: "n", program: "a", on: []}]},
			keys: {},
		});
	});

	it("refuses a graph that is not a graph, naming where and what it got", async () => {
		const error = await refusal("bad-graph");
		expect(error.reason).toBe("not a v1 config at graph: Expected object");
	});

	it("refuses a version the schema does not know", async () => {
		const error = await refusal("wrong-version");
		expect(error.reason).toBe("not a v1 config at version: Expected 1");
	});

	it("refuses a module that throws, naming the module and the thrown reason", async () => {
		const error = await refusal("throws");
		expect(error.module).toBe(fixture("throws"));
		expect(error.reason).toBe("module threw while loading: boom at import time");
		expect(error.message).toBe(
			`config module ${fixture("throws")}: module threw while loading: boom at import time`,
		);
	});

	it("refuses a default export that is not a v1 config, naming the missing key", async () => {
		const error = await refusal("wrong-shape");
		expect(error.module).toBe(fixture("wrong-shape"));
		expect(error.reason).toBe("not a v1 config at version: Missing key");
	});

	it("refuses a module with no default export", async () => {
		const error = await refusal("no-default");
		expect(error.module).toBe(fixture("no-default"));
		expect(error.reason).toBe(
			"no default export; export default a {version: 1, programs: [...]} config",
		);
	});
});

describe("loadLayeredConfig", () => {
	it("merges the project layer over the global one by program id and node id, global order first", async () => {
		const config = await layered(fixture("global-layer"), fixture("project-layer"));
		expect(config).toEqual({
			programs: [{id: "a"}, {id: "b", core: "project"}],
			graph: {
				nodes: [
					{id: "n", program: "b", on: []},
					{id: "m", program: "a", on: []},
				],
			},
			keys: [
				{file: `global ${layerName("global-layer")}`, bindings: {}},
				{file: `project ${layerName("project-layer")}`, bindings: {}},
			],
			sources: [fixture("global-layer"), fixture("project-layer")],
		});
	});

	it("treats an absent layer as empty and names only the layers it found", async () => {
		const missing = fixture("does-not-exist");
		expect(await layered(missing, fixture("with-graph"))).toEqual({
			programs: [{id: "a"}],
			graph: {nodes: [{id: "n", program: "a", on: []}]},
			keys: [{file: `project ${layerName("with-graph")}`, bindings: {}}],
			sources: [fixture("with-graph")],
		});
		expect(await layered(fixture("two-rows"), missing)).toEqual({
			programs: [{id: "a"}, {id: "b"}],
			graph: {nodes: []},
			keys: [{file: `global ${layerName("two-rows")}`, bindings: {}}],
			sources: [fixture("two-rows")],
		});
		expect(await layered(missing, missing)).toEqual({
			programs: [],
			graph: {nodes: []},
			keys: [],
			sources: [],
		});
	});

	it("carries each layer's key bindings as its own source, named for the layer", async () => {
		const config = await layered(fixture("keys"), fixture("does-not-exist"));
		expect(config.keys).toEqual([
			{
				file: `global ${layerName("keys")}`,
				bindings: {"ctrl-h": "help", "ctrl-x": {command: "spell list", repeat: true}},
			},
		]);
	});

	it("still refuses a layer that exists and is broken", async () => {
		const error = await Effect.runPromise(
			Effect.flip(
				loadLayeredConfig({global: fixture("throws"), project: fixture("two-rows")}).pipe(
					Effect.provide(NodeFileSystem.layer),
				),
			),
		);
		expect(error).toBeInstanceOf(ConfigLoadError);
		expect(error.module).toBe(fixture("throws"));
	});
});
