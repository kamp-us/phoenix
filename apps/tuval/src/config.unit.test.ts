import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {featuresDefault} from "@kampus/tuval-sdk/kernel/features";
import {NodeId} from "@kampus/tuval-sdk/kernel/ports/graph";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {applyKeysConfig, defaultPrefixTable} from "@kampus/tuval-ui/keys";
import {Effect, Result} from "effect";
import {AuthoredModules} from "./authored-modules.ts";
import {
	ConfigLoadError,
	DeclaredFeatures,
	type LoadedConfig,
	loadConfigModule,
	loadLayeredConfig,
	loadProjectConfig,
} from "./config.ts";
import {fixtureDesk, noDesk} from "./config-fixtures/desk-layers.ts";
import {ProjectId} from "./project-id.ts";
import {DESK_SDK_VERSION, nothingRemoved} from "./sdk-admission.ts";

const fixture = (name: string) =>
	fileURLToPath(new URL(`./config-fixtures/${name}.ts`, import.meta.url));

/** How `describeFile` names a fixture module: relative to the directory two levels above it. */
const layerName = (name: string) => `config-fixtures/${name}.ts`;

const refusal = (name: string) =>
	Effect.map(Effect.flip(loadConfigModule(fixture(name))), (error) => {
		assert.instanceOf(error, ConfigLoadError);
		return error;
	});

/** The project a fixture project layer loads as; its key is what scopes that layer's ids. */
const alpha = ProjectId.of("/work/alpha");

/** The merge, without the per-owner parts it was assembled from. */
const layered = (global: string, project: string, desk = noDesk, id = alpha) =>
	loadLayeredConfig({desk, global, projects: [{id, module: project}]}).pipe(
		Effect.map(({desk: _desk, projects: _projects, ...merged}) => merged),
		Effect.provide(NodeFileSystem.layer),
	);

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

	it.effect("resolve the global layer's flags over the defaults", () =>
		Effect.gen(function* () {
			const merged = yield* layered(fixture("features-on"), fixture("two-rows"));
			assert.deepStrictEqual(merged.features, {
				subagentList: true,
				piSubagents: true,
				piKernelTools: false,
				kernelChildren: false,
				windowTitles: false,
				processBoard: false,
				prReviewExample: false,
				processRemove: false,
			});
		}),
	);

	// The direction that costs something: `subagentList` defaults on, so an operator turning it off
	// is a layer stating `false` over a `true` default, and a merge folding the layers the other way
	// round would silently ignore them.
	it.effect("let a global layer that states a flag off win over the on default", () =>
		Effect.gen(function* () {
			const global = yield* layered(fixture("features-off"), fixture("two-rows"));
			assert.deepStrictEqual(global.features, {
				subagentList: false,
				piSubagents: true,
				piKernelTools: false,
				kernelChildren: false,
				windowTitles: false,
				processBoard: false,
				prReviewExample: false,
				processRemove: false,
			});
		}),
	);

	// A key the schema does not declare is a key the decode drops, so a flag missing from
	// `DeclaredFeatures` reads as a config that stated nothing (#8595).
	it.effect("keep a stated piSubagents rather than dropping it at the decode", () =>
		Effect.gen(function* () {
			const config = yield* loadConfigModule(fixture("pi-subagents-off"));
			assert.deepStrictEqual(config.features, {piSubagents: false});
		}),
	);

	it.effect("let the global layer turn piSubagents off against its on default", () =>
		Effect.gen(function* () {
			const global = yield* layered(fixture("pi-subagents-off"), fixture("two-rows"));
			assert.deepStrictEqual(global.features, {...featuresDefault, piSubagents: false});
		}),
	);

	it.effect("keep a stated piKernelTools rather than dropping it at the decode", () =>
		Effect.gen(function* () {
			const config = yield* loadConfigModule(fixture("pi-kernel-tools-on"));
			assert.deepStrictEqual(config.features, {piKernelTools: true});
		}),
	);

	it.effect("let the global layer turn piKernelTools on against its off default", () =>
		Effect.gen(function* () {
			const global = yield* layered(fixture("pi-kernel-tools-on"), fixture("two-rows"));
			assert.deepStrictEqual(global.features, {...featuresDefault, piKernelTools: true});
		}),
	);

	// The derivation is what makes a hand-listed key impossible to forget, and this is the assertion
	// that reds if it is ever unwound back to a literal (#8595, #8783).
	it("declare exactly the keys featuresDefault carries", () => {
		assert.deepStrictEqual(
			Object.keys(DeclaredFeatures.fields).sort(),
			Object.keys(featuresDefault).sort(),
		);
	});
});

describe("loadLayeredConfig and the SDK range (#9686)", () => {
	it.effect(
		"refuses a row outside the desk's SDK and a malformed one, and loads the rest of the layer",
		() =>
			Effect.gen(function* () {
				const config = yield* layered(fixture("sdk-ranges"), fixture("does-not-exist"));
				assert.deepStrictEqual(
					config.programs.map((row) => (row as {readonly id: string}).id),
					["in-range", "undeclared"],
				);
				assert.deepStrictEqual(
					config.graph.nodes.map((node) => node.id),
					["kept", "plain"],
				);
				assert.deepStrictEqual(config.graph.nodes[0]?.on, []);
				assert.deepStrictEqual(
					config.refused.map((refusal) => refusal.message),
					[
						`program "too-new" supports @kampus/tuval-sdk >=1.0.0, and this desk runs ${DESK_SDK_VERSION}; it was not loaded`,
						`program "garbled" declares @kampus/tuval-sdk range "not a range", which is not a semver range (this desk runs ${DESK_SDK_VERSION}); it was not loaded`,
					],
				);
			}),
	);

	it.effect("names a refused project row by its project-scoped id", () =>
		Effect.gen(function* () {
			const config = yield* layered(fixture("does-not-exist"), fixture("sdk-ranges"));
			assert.deepStrictEqual(
				config.refused.map((refusal) => refusal.program),
				[alpha.scope("too-new"), alpha.scope("garbled")],
			);
			assert.deepStrictEqual(
				config.graph.nodes.map((node) => node.id),
				[alpha.scope("kept"), alpha.scope("plain")],
			);
		}),
	);

	it.effect(
		"drops a project's nodes that name a refused global row or its nodes by bare id, and loads the rest",
		() =>
			Effect.gen(function* () {
				const config = yield* layered(
					fixture("sdk-out-of-range-counter"),
					fixture("names-refused-global"),
				);
				assert.deepStrictEqual(
					config.refused.map((refusal) => refusal.program),
					["future-counter"],
				);
				assert.deepStrictEqual(
					config.graph.nodes.map((node) => ({id: node.id, on: node.on})),
					[
						{id: NodeId.make("main"), on: []},
						{id: NodeId.make(alpha.scope("own")), on: []},
					],
				);
			}),
	);

	it.effect("drops the same nodes when the project opens into a running desk", () =>
		Effect.gen(function* () {
			const layers = {desk: noDesk, projects: [], global: fixture("sdk-out-of-range-counter")};
			const running = yield* loadLayeredConfig(layers);
			const opened = yield* loadProjectConfig(
				noDesk,
				{id: alpha, module: fixture("names-refused-global")},
				running.desk.removed,
				running.features,
			);
			assert.deepStrictEqual(opened.config.refused, []);
			assert.deepStrictEqual(
				opened.config.graph.nodes.map((node) => ({id: node.id, on: node.on})),
				[{id: NodeId.make(alpha.scope("own")), on: []}],
			);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});

describe("loadLayeredConfig", () => {
	it.effect(
		"keeps a global row and a same-id project row side by side, as <id> and <project>/<id>",
		() =>
			Effect.gen(function* () {
				const config = yield* layered(fixture("global-layer"), fixture("project-layer"));
				assert.deepStrictEqual(config, {
					programs: [
						{id: "a"},
						{id: "b", core: "global"},
						{id: alpha.scope("a")},
						{id: alpha.scope("b"), core: "project"},
					],
					features: {
						subagentList: true,
						piSubagents: true,
						piKernelTools: false,
						kernelChildren: false,
						windowTitles: false,
						processBoard: false,
						prReviewExample: false,
						processRemove: false,
					},
					moduleRenderers: [],
					graph: {
						nodes: [
							{id: NodeId.make("n"), program: ProgramId.make("a"), on: []},
							{
								id: NodeId.make(alpha.scope("n")),
								program: ProgramId.make(alpha.scope("b")),
								on: [],
							},
							{
								id: NodeId.make(alpha.scope("m")),
								program: ProgramId.make(alpha.scope("a")),
								on: [],
							},
						],
					},
					keys: [
						{file: `global ${layerName("global-layer")}`, bindings: {}},
						{file: `project ${layerName("project-layer")}`, bindings: {}},
					],
					sources: [fixture("global-layer"), fixture("project-layer")],
					refused: [],
					files: [fixture("global-layer"), fixture("project-layer")],
					modules: AuthoredModules.none,
				});
			}),
	);

	it.effect("treats an absent layer as empty and names only the layers it found", () =>
		Effect.gen(function* () {
			const missing = fixture("does-not-exist");
			assert.deepStrictEqual(yield* layered(missing, fixture("with-graph")), {
				programs: [{id: alpha.scope("a")}],
				features: {
					subagentList: true,
					piSubagents: true,
					piKernelTools: false,
					kernelChildren: false,
					windowTitles: false,
					processBoard: false,
					prReviewExample: false,
					processRemove: false,
				},
				moduleRenderers: [],
				graph: {
					nodes: [
						{
							id: NodeId.make(alpha.scope("n")),
							program: ProgramId.make(alpha.scope("a")),
							on: [],
						},
					],
				},
				keys: [{file: `project ${layerName("with-graph")}`, bindings: {}}],
				sources: [fixture("with-graph")],
				refused: [],
				files: [fixture("with-graph")],
				modules: AuthoredModules.none,
			});
			assert.deepStrictEqual(yield* layered(fixture("two-rows"), missing), {
				programs: [{id: "a"}, {id: "b"}],
				features: {
					subagentList: true,
					piSubagents: true,
					piKernelTools: false,
					kernelChildren: false,
					windowTitles: false,
					processBoard: false,
					prReviewExample: false,
					processRemove: false,
				},
				moduleRenderers: [],
				graph: {nodes: []},
				keys: [{file: `global ${layerName("two-rows")}`, bindings: {}}],
				sources: [fixture("two-rows")],
				refused: [],
				files: [fixture("two-rows")],
				modules: AuthoredModules.none,
			});
			assert.deepStrictEqual(yield* layered(missing, missing), {
				programs: [],
				features: {
					subagentList: true,
					piSubagents: true,
					piKernelTools: false,
					kernelChildren: false,
					windowTitles: false,
					processBoard: false,
					prReviewExample: false,
					processRemove: false,
				},
				moduleRenderers: [],
				graph: {nodes: []},
				keys: [],
				sources: [],
				refused: [],
				files: [],
				modules: AuthoredModules.none,
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
		"names each module renderer beside the layer module that declared it, first declaration winning",
		() =>
			Effect.gen(function* () {
				const global = fixture("module-renderer-global");
				const project = fixture("module-renderer-project");
				const config = yield* layered(global, project);
				assert.deepStrictEqual(config.moduleRenderers, [
					{ref: "@global/win/window", origin: global},
					// Row `b` is declared in both layers and both rows load, naming one specifier. The page
					// resolves a specifier once, from the first layer that named it.
					{ref: "@shared/win/window", origin: global},
					{ref: "@project/win/window", origin: project},
				]);
			}),
	);

	it.effect("still refuses a layer that exists and is broken", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				loadLayeredConfig({
					desk: noDesk,
					global: fixture("throws"),
					projects: [{id: alpha, module: fixture("two-rows")}],
				}).pipe(Effect.provide(NodeFileSystem.layer)),
			);
			assert.instanceOf(error, ConfigLoadError);
			assert.strictEqual(error.module, fixture("throws"));
		}),
	);

	it.effect(
		"reads desk, then global, then project: the desk's rows and nodes first, then the file layers",
		() =>
			Effect.gen(function* () {
				const config = yield* layered(
					fixture("global-layer"),
					fixture("project-layer"),
					fixtureDesk,
				);
				assert.deepStrictEqual(config.programs, [
					{id: "desk"},
					{id: "a"},
					{id: "b", core: "global"},
					{id: alpha.scope("a")},
					{id: alpha.scope("b"), core: "project"},
				]);
				assert.deepStrictEqual(
					config.graph.nodes.map((node) => node.id),
					["desk", "n", alpha.scope("n"), alpha.scope("m")],
				);
				// The desk is code, not a file: it is neither a source nor a watched file.
				assert.deepStrictEqual(config.sources, [fixture("global-layer"), fixture("project-layer")]);
			}),
	);

	it.effect("supplies the desk's rows when no file layer exists at all", () =>
		Effect.gen(function* () {
			const missing = fixture("does-not-exist");
			const config = yield* layered(missing, missing, fixtureDesk);
			assert.deepStrictEqual(config.programs, [{id: "desk"}]);
			assert.deepStrictEqual(config.graph.nodes, fixtureDesk.graph.nodes);
			assert.deepStrictEqual(config.sources, []);
		}),
	);

	it.effect(
		"refuses a global or project layer that declares a desk row, naming the file and the desk",
		() =>
			Effect.gen(function* () {
				const missing = fixture("does-not-exist");
				const stale = fixture("redeclares-desk-row");
				for (const [global, project] of [
					[stale, missing],
					[missing, stale],
				] as const) {
					const error = yield* Effect.flip(layered(global, project, fixtureDesk));
					assert.instanceOf(error, ConfigLoadError);
					assert.strictEqual(error.module, stale);
					assert.strictEqual(
						error.reason,
						'declares program row "desk", which the desk supplies itself; remove the row and its graph node',
					);
					assert.include(error.message, stale);
					assert.include([...error.files], stale);
				}
			}),
	);

	it.effect("refuses a layer that declares a desk graph node under a row of its own", () =>
		Effect.gen(function* () {
			const stale = fixture("redeclares-desk-node");
			const error = yield* Effect.flip(layered(fixture("two-rows"), stale, fixtureDesk));
			assert.strictEqual(error.module, stale);
			assert.strictEqual(
				error.reason,
				'declares graph node "desk", which the desk supplies itself; remove the node',
			);
			// The global layer loaded first and passed, so the refusal names it among the files read.
			assert.includeMembers([...error.files], [fixture("two-rows"), stale]);
		}),
	);

	it.effect("names the layers a refused load read, the refusing one among them", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(layered(fixture("two-rows"), fixture("throws")));
			assert.strictEqual(error.module, fixture("throws"));
			assert.includeMembers([...error.files], [fixture("two-rows"), fixture("throws")]);
		}),
	);
});

describe("project-scoped ids (#9684)", () => {
	const node = (id: string) => (config: Pick<LoadedConfig, "graph">) =>
		config.graph.nodes.find((candidate) => candidate.id === id);

	it.effect(
		"resolves a project's bare connection to its own row or node first, and to the global one otherwise",
		() =>
			Effect.gen(function* () {
				const config = yield* layered(fixture("scoped-global"), fixture("scoped-project"));
				// `counter` is declared in both layers, and the project's node reaches its own.
				// `log` and `hub` are global only, so the project's connections to them stay bare.
				assert.deepStrictEqual(node(alpha.scope("main"))(config), {
					id: NodeId.make(alpha.scope("main")),
					program: ProgramId.make(alpha.scope("counter")),
					on: [
						{port: "out", to: {node: NodeId.make(alpha.scope("sink")), port: "in"}},
						{port: "out", to: {node: NodeId.make("hub"), port: "in"}},
					],
				});
				assert.deepStrictEqual(node(alpha.scope("sink"))(config), {
					id: NodeId.make(alpha.scope("sink")),
					program: ProgramId.make("log"),
					parent: NodeId.make(alpha.scope("main")),
					on: [],
				});
				// The global node of the same name still runs the global row.
				assert.deepStrictEqual(node("main")(config), {
					id: NodeId.make("main"),
					program: ProgramId.make("counter"),
					on: [],
				});
			}),
	);

	it.effect("gives two projects' `main` nodes two distinct process ids", () =>
		Effect.gen(function* () {
			const beta = ProjectId.of("/work/beta");
			const first = yield* layered(fixture("scoped-global"), fixture("scoped-project"));
			const second = yield* layered(
				fixture("scoped-global"),
				fixture("scoped-project"),
				noDesk,
				beta,
			);
			const mains = [first, second].map((config) =>
				config.graph.nodes.map((candidate) => candidate.id).filter((id) => id.endsWith("/main")),
			);
			assert.deepStrictEqual(mains, [[alpha.scope("main")], [beta.scope("main")]]);
			assert.notStrictEqual(alpha.scope("main"), beta.scope("main"));
		}),
	);

	it.effect("refuses a project connection to another project's program, naming both ends", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(layered(fixture("scoped-global"), fixture("cross-project")));
			assert.instanceOf(error, ConfigLoadError);
			assert.strictEqual(error.module, fixture("cross-project"));
			assert.strictEqual(
				error.reason,
				`project node "${alpha.scope("main")}" connects to "-work-beta/sink", another project's; a project connects only to its own programs and global ones`,
			);
		}),
	);

	it.effect("refuses a subproject connection up to its parent's program, naming both ends", () =>
		Effect.gen(function* () {
			const beta = ProjectId.of("/work/beta");
			const layer = {id: alpha, module: fixture("cross-project"), parent: beta};
			const error = yield* Effect.flip(
				loadProjectConfig(noDesk, layer, nothingRemoved, featuresDefault),
			);
			assert.instanceOf(error, ConfigLoadError);
			assert.strictEqual(
				error.reason,
				`subproject node "${alpha.scope("main")}" connects to "${beta.scope("sink")}", its parent beta's; a subproject's config cannot connect up to its parent`,
			);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("refuses a global connection into a project", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				layered(fixture("global-into-project"), fixture("does-not-exist")),
			);
			assert.strictEqual(error.module, fixture("global-into-project"));
			assert.strictEqual(
				error.reason,
				`global node "hub" connects to "${alpha.scope("counter")}", a project's; a global program reaches a project only through a connection that project's config declares`,
			);
		}),
	);

	it.effect("refuses a declared id carrying the scope separator, in either layer", () =>
		Effect.gen(function* () {
			const missing = fixture("does-not-exist");
			const reserved = fixture("separator-row");
			for (const [global, project] of [
				[reserved, missing],
				[missing, reserved],
			] as const) {
				const error = yield* Effect.flip(layered(global, project));
				assert.strictEqual(error.module, reserved);
				assert.strictEqual(
					error.reason,
					'declares program row "tools/counter"; "/" is reserved for project-scoped ids',
				);
			}
		}),
	);
});

/** Flags and the desk's reserved keys are global only (#9687, ruling #9668 R4.2). */
describe("loadLayeredConfig and what is global only (#9687)", () => {
	const refusedLoad = (global: string, project: string, desk = noDesk) =>
		Effect.map(Effect.flip(layered(global, project, desk)), (error) => {
			assert.instanceOf(error, ConfigLoadError);
			return error;
		});

	it.effect("refuses a project layer's features block, naming the module and its flags", () =>
		Effect.gen(function* () {
			const error = yield* refusedLoad(fixture("two-rows"), fixture("features-off"));
			assert.strictEqual(error.module, fixture("features-off"));
			assert.strictEqual(
				error.reason,
				"states feature flags (subagentList); flags are global only, so state them in the global .tuval/tuval.config.ts",
			);
		}),
	);

	it.effect("refuses a project binding for a reserved desk key, naming the key and the file", () =>
		Effect.gen(function* () {
			const error = yield* refusedLoad(fixture("two-rows"), fixture("binds-reserved-key"));
			assert.strictEqual(
				error.message,
				`config module ${fixture("binds-reserved-key")}: binds "<C-b>x", the desk's reserved key for the window:close chord; a project cannot rebind a reserved desk key`,
			);
		}),
	);

	it.effect("leaves the global layer free to bind a reserved key", () =>
		Effect.gen(function* () {
			const config = yield* layered(fixture("binds-reserved-key"), fixture("does-not-exist"));
			assert.deepStrictEqual(config.sources, [fixture("binds-reserved-key")]);
		}),
	);

	it.effect(
		"reads the reserved keys off the desk's own grammar, so a rebound prefix moves them",
		() =>
			Effect.gen(function* () {
				const table = Result.getOrThrow(applyKeysConfig(defaultPrefixTable, {prefix: "<c-a>"}));
				const rebound = {...noDesk, table};
				const config = yield* layered(fixture("two-rows"), fixture("binds-reserved-key"), rebound);
				assert.deepStrictEqual(config.sources, [
					fixture("two-rows"),
					fixture("binds-reserved-key"),
				]);
			}),
	);

	it.effect("refuses a project row needing a flag the global layer leaves off, naming both", () =>
		Effect.gen(function* () {
			const config = yield* layered(fixture("does-not-exist"), fixture("needs-board-flag"));
			assert.deepStrictEqual(
				config.refused.map((refusal) => refusal.message),
				[
					`program "${alpha.scope("board-only")}" needs feature flag "processBoard", which the global config leaves off; it was not loaded`,
				],
			);
			assert.deepStrictEqual(config.programs, [{id: alpha.scope("plain")}]);
			assert.deepStrictEqual(config.graph.nodes, []);
		}),
	);

	it.effect("admits the same row once the global layer turns the flag on", () =>
		Effect.gen(function* () {
			const config = yield* layered(fixture("board-on"), fixture("needs-board-flag"));
			assert.deepStrictEqual(config.refused, []);
			assert.strictEqual(config.features.processBoard, true);
			assert.deepStrictEqual(
				config.programs.map((row) => (row as {readonly id: string}).id),
				[alpha.scope("board-only"), alpha.scope("plain")],
			);
		}),
	);

	it.effect("checks a project opening into a running desk against the flags that desk runs", () =>
		Effect.gen(function* () {
			const layer = {id: alpha, module: fixture("needs-board-flag")};
			const off = yield* loadProjectConfig(noDesk, layer, nothingRemoved, featuresDefault);
			assert.deepStrictEqual(
				off.config.refused.map((refusal) => refusal.program),
				[alpha.scope("board-only")],
			);
			const on = yield* loadProjectConfig(noDesk, layer, nothingRemoved, {
				...featuresDefault,
				processBoard: true,
			});
			assert.deepStrictEqual(on.config.refused, []);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
