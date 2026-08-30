import {fileURLToPath} from "node:url";
import {
	DefaultPackageManager,
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, FileSystem, Layer, Path, Schema} from "effect";
import {makeExtensionUI, PackageExtensionUI} from "../src/backend/extension-ui.js";
import {
	buildPackageBackendLayers,
	ContributionStartupFailure,
	contributionAssetUrl,
	emitContributionCatalog,
	loadPackageContributions,
	PublicPackageIdentity,
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
						packageName: PublicPackageIdentity.make("fixture-plain-pi"),
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
				[
					{kind: "node", key: "fixture.node"},
					{kind: "edge", key: "fixture.edge"},
					{kind: "panel", key: "fixture.panel"},
				],
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
				["fixture.node", "fixture.edge", "fixture.panel"],
			);
			assert.deepStrictEqual(
				catalog.diagnostics.map(({packageName}) => packageName),
				["invalid-contract", "missing-asset"],
			);
		}),
	);

	it.effect("isolates backend layer construction failures with package diagnostics", () =>
		Effect.gen(function* () {
			const catalog = yield* load(fixture("backend-failure"));
			const diagnostics = yield* buildPackageBackendLayers(catalog);
			assert.lengthOf(diagnostics, 1);
			assert.strictEqual(diagnostics[0]?.packageName, "backend-failure");
			assert.strictEqual(diagnostics[0]?.reason, "backend-layer-build-failed");
			assert.strictEqual(
				diagnostics[0]?.message,
				"Backend contribution Layer could not be activated",
			);
		}),
	);

	it.effect("emits portable same-origin asset URLs without importing frontend assets", () =>
		Effect.gen(function* () {
			const catalog = yield* load(fixture("plain-pi"));
			const emitted = emitContributionCatalog(catalog);
			assert.strictEqual(emitted.contractVersion, 1);
			assert.deepStrictEqual(
				emitted.frontend.map(({kind, key}) => ({kind, key})),
				[
					{kind: "node", key: "fixture.node"},
					{kind: "edge", key: "fixture.edge"},
					{kind: "panel", key: "fixture.panel"},
				],
			);
			const asset = emitted.frontend[0]?.asset ?? "";
			assert.match(asset, /^\/api\/contribution-assets\/v1-[a-f0-9]{64}\.js$/);
			assert.isFalse(JSON.stringify(emitted).includes(fixtures));
			assert.include(
				new TextDecoder().decode(catalog.assetFiles.get(asset)),
				"fixture-package-node",
			);
			const reloaded = emitContributionCatalog(yield* load(fixture("plain-pi")));
			assert.strictEqual(reloaded.frontend[0]?.asset, asset);
		}),
	);

	it("content-versions contribution module URLs", () => {
		const first = contributionAssetUrl(new TextEncoder().encode("export default 1"));
		const same = contributionAssetUrl(new TextEncoder().encode("export default 1"));
		const changed = contributionAssetUrl(new TextEncoder().encode("export default 2"));
		assert.strictEqual(first, same);
		assert.notStrictEqual(first, changed);
		assert.match(first, /^\/api\/contribution-assets\/v1-[a-f0-9]{64}\.js$/);
	});

	it.effect("binds the resolved package name into each server-loaded backend Layer", () =>
		Effect.gen(function* () {
			const observed: Array<string> = [];
			const layer = Layer.effectDiscard(
				Effect.gen(function* () {
					const extensionUI = yield* PackageExtensionUI;
					observed.push(extensionUI.packageName);
				}),
			);
			yield* buildPackageBackendLayers(
				{
					contractVersion: 1,
					backend: [
						{
							packageName: PublicPackageIdentity.make("portable-package"),
							source: "fixture",
							module: "fixture.js",
							exportName: "makeLayer",
							layer,
						},
					],
					frontend: [],
					assetFiles: new Map(),
					diagnostics: [],
				},
				makeExtensionUI(),
			);
			assert.deepStrictEqual(observed, ["portable-package"]);
		}),
	);

	it("admits only canonical public npm package identities", () => {
		const valid = ["pi", "package-name", "package.name", "package_name", "@scope/name"];
		const invalid = [
			"",
			"/absolute/package",
			"./relative",
			"../parent",
			"C:\\windows\\package",
			"file:///local/package",
			"scope/name",
			"@scope/name/extra",
			"@scope/../name",
			".",
			"..",
			"package%2fname",
			"package%5Cname",
			"package\u0000name",
		];
		for (const identity of valid) {
			assert.strictEqual(Schema.decodeUnknownOption(PublicPackageIdentity)(identity)._tag, "Some");
		}
		for (const identity of invalid) {
			assert.strictEqual(Schema.decodeUnknownOption(PublicPackageIdentity)(identity)._tag, "None");
		}
	});

	it.effect("serializes only closed diagnostics and validated public values", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-public-diagnostics-"});
			const packageRoot = path.join(root, "package");
			yield* fs.makeDirectory(packageRoot);
			yield* fs.writeFileString(
				path.join(packageRoot, "extension.js"),
				"export default function() {}",
			);
			const packageJson = path.join(packageRoot, "package.json");
			const writeManifest = (name: string, tuval: unknown) =>
				fs.writeFileString(
					packageJson,
					JSON.stringify({name, type: "module", pi: {extensions: ["./extension.js"]}, tuval}),
				);
			yield* writeManifest("diagnostic-package", undefined);
			const settingsManager = settingsFor(packageRoot);
			const packageManager = new DefaultPackageManager({
				cwd: root,
				agentDir: root,
				settingsManager,
			});
			const resolved = yield* Effect.tryPromise({
				try: () => packageManager.resolve(),
				catch: (cause) =>
					new ContributionStartupFailure({
						packageName: PublicPackageIdentity.make("diagnostic-package"),
						message: "Diagnostic fixture package resolution failed",
						cause,
					}),
			});
			packageManager.resolve = async () => resolved;
			const options = {cwd: root, agentDir: root, settingsManager, packageManager};
			const malicious = [
				"/private/absolute-secret.js",
				"../local-secret.js",
				"encoded%2fsecret.js",
				"encoded%5Csecret.js",
			];
			for (const value of malicious) {
				yield* writeManifest("diagnostic-package", {
					contractVersion: 1,
					frontend: {nodes: [{key: "safe.key", asset: value}]},
				});
				const serialized = JSON.stringify(
					emitContributionCatalog(yield* loadPackageContributions(options)),
				);
				assert.notInclude(serialized, value);
				assert.notInclude(serialized, root);
				assert.include(serialized, '"reason":"asset-unavailable"');
				assert.include(serialized, '"key":"safe.key"');
			}
			for (const value of malicious) {
				yield* writeManifest("diagnostic-package", {
					contractVersion: 1,
					backend: [{module: value, export: "unsafeFactory"}],
				});
				const serialized = JSON.stringify(
					emitContributionCatalog(yield* loadPackageContributions(options)),
				);
				assert.notInclude(serialized, value);
				assert.notInclude(serialized, root);
				assert.include(serialized, '"reason":"backend-module-unavailable"');
			}
			for (const value of ["/absolute/name", "../local-name", "encoded%2fname"]) {
				yield* writeManifest(value, {contractVersion: 1});
				const serialized = JSON.stringify(
					emitContributionCatalog(yield* loadPackageContributions(options)),
				);
				assert.notInclude(serialized, value);
				assert.notInclude(serialized, root);
				assert.include(serialized, '"reason":"package-name-invalid"');
				assert.match(serialized, /unidentified-(?:user|project|temporary)-package-1/);
			}
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"canonicalizes same-root links and rejects non-files and links outside the package",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-canonical-assets-"});
				const outside = yield* fs.makeTempDirectoryScoped({prefix: "tuval-outside-assets-"});
				const outsideFile = path.join(outside, "outside.js");
				yield* fs.writeFileString(outsideFile, "export const outside = true;");
				const packageRoots: Array<string> = [];
				for (const [name, configure] of [
					["same-root-link", "same"] as const,
					["outside-link", "outside"] as const,
					["directory-asset", "directory"] as const,
				]) {
					const packageRoot = path.join(root, name);
					packageRoots.push(packageRoot);
					yield* fs.makeDirectory(packageRoot);
					yield* fs.writeFileString(
						path.join(packageRoot, "extension.js"),
						"export default function() {}",
					);
					const asset = path.join(packageRoot, "asset.js");
					if (configure === "same") {
						yield* fs.writeFileString(
							path.join(packageRoot, "target.js"),
							"export const same = true;",
						);
						yield* fs.symlink(path.join(packageRoot, "target.js"), asset);
					} else if (configure === "outside") {
						yield* fs.symlink(outsideFile, asset);
					} else {
						yield* fs.makeDirectory(asset);
					}
					yield* fs.writeFileString(
						path.join(packageRoot, "package.json"),
						JSON.stringify({
							name,
							type: "module",
							pi: {extensions: ["./extension.js"]},
							tuval: {
								contractVersion: 1,
								frontend: {nodes: [{key: `${name}.node`, asset: "./asset.js"}]},
							},
						}),
					);
				}
				const catalog = yield* load(...packageRoots);
				assert.deepStrictEqual(
					catalog.frontend.map(({packageName}) => packageName),
					["same-root-link"],
				);
				const assetUrl = catalog.frontend[0]?.asset ?? "";
				assert.strictEqual(
					new TextDecoder().decode(catalog.assetFiles.get(assetUrl)),
					"export const same = true;",
				);
				assert.deepStrictEqual(
					catalog.diagnostics.map(({packageName, reason}) => ({packageName, reason})),
					[
						{packageName: "outside-link", reason: "asset-unavailable"},
						{packageName: "directory-asset", reason: "asset-unavailable"},
					],
				);
			}).pipe(Effect.provide(NodeServices.layer)),
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
