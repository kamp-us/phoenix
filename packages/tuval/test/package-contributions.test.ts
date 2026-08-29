import {fileURLToPath} from "node:url";
import {
	DefaultPackageManager,
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import {
	buildPackageBackendLayers,
	ContributionStartupFailure,
	emitContributionCatalog,
	loadPackageContributions,
} from "../src/backend/package-contributions.js";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const settingsFor = (...packages: ReadonlyArray<string>) =>
	SettingsManager.inMemory({packages: [...packages]}, {projectTrusted: true});

const load = (...packages: ReadonlyArray<string>) => {
	const settingsManager = settingsFor(...packages);
	return loadPackageContributions({
		cwd: fixtures,
		agentDir: fixtures,
		settingsManager,
		packageManager: new DefaultPackageManager({
			cwd: fixtures,
			agentDir: fixtures,
			settingsManager,
		}),
	}).pipe(Effect.provide(NodeServices.layer));
};

describe("pi-native Tuval package contributions", () => {
	it.effect("keeps an optional Tuval package compatible with plain pi extension loading", () =>
		Effect.gen(function* () {
			const settingsManager = settingsFor(fixture("plain-pi"));
			const loader = new DefaultResourceLoader({
				cwd: fixtures,
				agentDir: fixtures,
				settingsManager,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			yield* Effect.tryPromise({
				try: () => loader.reload(),
				catch: (cause) =>
					new ContributionStartupFailure({
						packageName: "fixture-plain-pi",
						message: "Plain pi extension loading failed",
						cause,
					}),
			});
			const extensions = loader.getExtensions();
			assert.strictEqual(extensions.errors.length, 0);
			assert.strictEqual(extensions.extensions.length, 1);

			const catalog = yield* load(fixture("plain-pi"));
			assert.deepStrictEqual(
				catalog.frontend.map(({kind, key}) => ({kind, key})),
				[{kind: "node", key: "fixture.node"}],
			);
			assert.strictEqual(catalog.backend.length, 1);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("preserves pi precedence, dedupes roots, and fails a shadowed package closed", () =>
		Effect.gen(function* () {
			const catalog = yield* load(
				fixture("precedence-high"),
				fixture("precedence-high"),
				fixture("precedence-low"),
			);
			assert.deepStrictEqual(
				catalog.frontend.map(({packageName, key}) => ({packageName, key})),
				[{packageName: "precedence-high", key: "shared.panel"}],
			);
			assert.match(
				catalog.diagnostics[0]?.message ?? "",
				/shadowed by a higher-precedence package/,
			);
		}),
	);

	it.effect("rejects unsupported contracts and missing assets per package", () =>
		Effect.gen(function* () {
			const catalog = yield* load(
				fixture("plain-pi"),
				fixture("invalid-contract"),
				fixture("missing-asset"),
			);
			assert.deepStrictEqual(
				catalog.frontend.map(({key}) => key),
				["fixture.node"],
			);
			assert.deepStrictEqual(
				catalog.diagnostics.map(({packageName}) => packageName),
				["invalid-contract", "missing-asset"],
			);
		}),
	);

	it.effect("surfaces backend layer construction failures", () =>
		Effect.gen(function* () {
			const catalog = yield* load(fixture("backend-failure"));
			const exit = yield* Effect.exit(buildPackageBackendLayers(catalog));
			assert.isTrue(Exit.isFailure(exit));
		}),
	);

	it.effect("emits portable same-origin asset URLs without importing frontend assets", () =>
		Effect.gen(function* () {
			const catalog = yield* load(fixture("plain-pi"));
			const emitted = emitContributionCatalog(catalog);
			assert.strictEqual(emitted.contractVersion, 1);
			assert.deepStrictEqual(
				emitted.frontend.map(({kind, key}) => ({kind, key})),
				[{kind: "node", key: "fixture.node"}],
			);
			const asset = emitted.frontend[0]?.asset ?? "";
			assert.match(asset, /^\/api\/contribution-assets\/v1-\d+\.js$/);
			assert.isFalse(JSON.stringify(emitted).includes(fixtures));
			assert.strictEqual(catalog.assetFiles.get(asset), fixture("plain-pi/asset.txt"));
			const reloaded = emitContributionCatalog(yield* load(fixture("plain-pi")));
			assert.strictEqual(reloaded.frontend[0]?.asset, asset);
		}),
	);

	it.effect("loads Tuval's built-in capability through its own pi package manifest", () =>
		Effect.gen(function* () {
			const packageRoot = fileURLToPath(new URL("..", import.meta.url));
			const catalog = yield* load(packageRoot);
			assert.deepStrictEqual(
				catalog.frontend.map(({key}) => key),
				["tuval.sessions"],
			);
			assert.strictEqual(catalog.backend[0]?.exportName, "makeTuvalBuiltinLayer");
			yield* buildPackageBackendLayers(catalog);
		}),
	);
});
