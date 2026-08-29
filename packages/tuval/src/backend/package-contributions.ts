import {pathToFileURL} from "node:url";
import {
	DefaultPackageManager,
	getAgentDir,
	type PackageManager,
	type PathMetadata,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {Effect, FileSystem, Layer, Path, Result, Schema} from "effect";
import {
	type ExtensionUIService,
	makeExtensionUI,
	PackageExtensionUI,
	packageExtensionUI,
} from "./extension-ui.js";
import {parsePackageJson} from "./package-json.js";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
export const PublicPackageIdentity = Schema.String.check(
	Schema.isMaxLength(214),
	Schema.isPattern(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/),
).pipe(Schema.brand("TuvalPublicPackageIdentity"));
export type PublicPackageIdentity = typeof PublicPackageIdentity.Type;
export const PublicContributionKey = Schema.String.check(
	Schema.isPattern(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
).pipe(Schema.brand("TuvalPublicContributionKey"));
export type PublicContributionKey = typeof PublicContributionKey.Type;

class BackendEntry extends Schema.Class<BackendEntry>("TuvalBackendEntry")({
	module: NonEmptyString,
	export: NonEmptyString,
}) {}

class FrontendEntry extends Schema.Class<FrontendEntry>("TuvalFrontendEntry")({
	key: PublicContributionKey,
	asset: NonEmptyString,
}) {}

class FrontendManifest extends Schema.Class<FrontendManifest>("TuvalFrontendManifest")({
	nodes: Schema.optionalKey(Schema.Array(FrontendEntry)),
	edges: Schema.optionalKey(Schema.Array(FrontendEntry)),
	panels: Schema.optionalKey(Schema.Array(FrontendEntry)),
}) {}

class TuvalManifest extends Schema.Class<TuvalManifest>("TuvalManifest")({
	contractVersion: Schema.Literal(1),
	backend: Schema.optionalKey(Schema.Array(BackendEntry)),
	frontend: Schema.optionalKey(FrontendManifest),
}) {}

class PackageFile extends Schema.Class<PackageFile>("TuvalPackageFile")({
	name: PublicPackageIdentity,
	tuval: Schema.optionalKey(Schema.Unknown),
}) {}

export type ContributionKind = "node" | "edge" | "panel";

export interface FrontendContribution {
	readonly kind: ContributionKind;
	readonly key: PublicContributionKey;
	readonly asset: string;
	readonly packageName: PublicPackageIdentity;
	readonly source: string;
}

type BackendLayer = Layer.Layer<never, unknown, PackageExtensionUI>;

const BackendLayer = Schema.declare<BackendLayer>((value): value is BackendLayer =>
	Layer.isLayer(value),
);

export interface BackendContribution {
	readonly packageName: PublicPackageIdentity;
	readonly source: string;
	readonly module: string;
	readonly exportName: string;
	readonly layer: BackendLayer;
}

type PackageDiagnosticReason =
	| "package-root-unavailable"
	| "package-manifest-unreadable"
	| "package-manifest-invalid-json"
	| "package-name-invalid"
	| "manifest-invalid"
	| "backend-module-unavailable"
	| "backend-export-not-factory"
	| "backend-export-not-layer"
	| "backend-layer-build-failed";

type KeyDiagnosticReason = "duplicate-key" | "shadowed-key" | "asset-unavailable";
export type ContributionDiagnosticReason = PackageDiagnosticReason | KeyDiagnosticReason;

type ContributionRejection =
	| {readonly reason: PackageDiagnosticReason}
	| {
			readonly reason: KeyDiagnosticReason;
			readonly kind: ContributionKind;
			readonly key: PublicContributionKey;
	  };

export type ContributionDiagnostic =
	| {
			readonly packageName: PublicPackageIdentity;
			readonly reason: PackageDiagnosticReason;
			readonly message: string;
	  }
	| {
			readonly packageName: PublicPackageIdentity;
			readonly reason: KeyDiagnosticReason;
			readonly kind: ContributionKind;
			readonly key: PublicContributionKey;
			readonly message: string;
	  };

export interface TuvalContributionCatalog {
	readonly contractVersion: 1;
	readonly backend: ReadonlyArray<BackendContribution>;
	readonly frontend: ReadonlyArray<FrontendContribution>;
	readonly assetFiles: ReadonlyMap<string, string>;
	readonly diagnostics: ReadonlyArray<ContributionDiagnostic>;
}

export class ContributionStartupFailure extends Schema.TaggedErrorClass<ContributionStartupFailure>()(
	"tuval/ContributionStartupFailure",
	{
		packageName: PublicPackageIdentity,
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export interface LoadPackageContributionsOptions {
	readonly cwd?: string;
	readonly agentDir?: string;
	readonly settingsManager?: SettingsManager;
	readonly packageManager?: PackageManager;
}

interface PackageRoot {
	readonly baseDir: string;
	readonly metadata: PathMetadata;
}

const packageRoots = (extensions: Awaited<ReturnType<PackageManager["resolve"]>>["extensions"]) => {
	const seen = new Set<string>();
	const roots: Array<PackageRoot> = [];
	for (const extension of extensions) {
		if (!extension.enabled || extension.metadata.origin !== "package") continue;
		const baseDir = extension.metadata.baseDir;
		if (baseDir === undefined || seen.has(baseDir)) continue;
		seen.add(baseDir);
		roots.push({baseDir, metadata: extension.metadata});
	}
	return roots;
};

const canonicalFileInside = Effect.fn("TuvalPackages.canonicalFileInside")(function* (
	fs: typeof FileSystem.FileSystem.Service,
	path: typeof Path.Path.Service,
	canonicalRoot: string,
	entry: string,
) {
	const candidate = yield* fs.realPath(path.resolve(canonicalRoot, entry));
	const relative = path.relative(canonicalRoot, candidate);
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		return undefined;
	}
	const info = yield* fs.stat(candidate);
	return info.type === "File" ? candidate : undefined;
});

const manifestFrontend = (manifest: TuvalManifest) => [
	...(manifest.frontend?.nodes ?? []).map((entry) => ({kind: "node" as const, entry})),
	...(manifest.frontend?.edges ?? []).map((entry) => ({kind: "edge" as const, entry})),
	...(manifest.frontend?.panels ?? []).map((entry) => ({kind: "panel" as const, entry})),
];

const contributionAssetUrl = (index: number) => `/api/contribution-assets/v1-${index}.js`;

const fallbackPackageIdentity = (metadata: PathMetadata, index: number) =>
	Schema.decodeSync(PublicPackageIdentity)(`unidentified-${metadata.scope}-package-${index + 1}`);

const diagnosticMessage = (rejection: ContributionRejection): string => {
	switch (rejection.reason) {
		case "package-root-unavailable":
			return "Package root is unavailable";
		case "package-manifest-unreadable":
			return "Package manifest is unreadable";
		case "package-manifest-invalid-json":
			return "Package manifest is not valid JSON";
		case "package-name-invalid":
			return "Package manifest has no valid public package identity";
		case "manifest-invalid":
			return "Tuval manifest is invalid or uses an unsupported contract";
		case "duplicate-key":
			return `${rejection.kind} contribution key ${rejection.key} is duplicated in its package`;
		case "shadowed-key":
			return `${rejection.kind} contribution key ${rejection.key} is shadowed by a higher-precedence package`;
		case "asset-unavailable":
			return `${rejection.kind} contribution key ${rejection.key} has no available package-contained file`;
		case "backend-module-unavailable":
			return "Backend contribution module is unavailable";
		case "backend-export-not-factory":
			return "Backend contribution export is not a factory";
		case "backend-export-not-layer":
			return "Backend contribution factory did not return an Effect Layer";
		case "backend-layer-build-failed":
			return "Backend contribution Layer could not be activated";
	}
};

export const loadPackageContributions = Effect.fn("TuvalPackages.load")(function* (
	options: LoadPackageContributionsOptions = {},
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const packageManager =
		options.packageManager ?? new DefaultPackageManager({cwd, agentDir, settingsManager});
	const resolved = yield* Effect.tryPromise({
		try: () => packageManager.resolve(),
		catch: (cause) =>
			new ContributionStartupFailure({
				packageName: PublicPackageIdentity.make("pi"),
				message: "Pi package resolution failed",
				cause,
			}),
	});
	const backend: Array<BackendContribution> = [];
	const frontend: Array<FrontendContribution> = [];
	const assetFiles = new Map<string, string>();
	const diagnostics: Array<ContributionDiagnostic> = [];
	const keys = new Set<string>();

	for (const [index, root] of packageRoots(resolved.extensions).entries()) {
		const packageJsonPath = path.join(root.baseDir, "package.json");
		const source = root.metadata.source;
		let packageIdentity = fallbackPackageIdentity(root.metadata, index);
		const reject = (rejection: ContributionRejection) => {
			diagnostics.push({
				packageName: packageIdentity,
				...rejection,
				message: diagnosticMessage(rejection),
			});
		};
		const text = yield* fs.readFileString(packageJsonPath).pipe(Effect.option);
		if (text._tag === "None") {
			reject({reason: "package-manifest-unreadable"});
			continue;
		}
		const parsedJson = parsePackageJson(text.value);
		if (parsedJson._tag === "Failed") {
			reject({reason: "package-manifest-invalid-json"});
			continue;
		}
		const packageFile = yield* Schema.decodeUnknownEffect(PackageFile)(parsedJson.value, {
			onExcessProperty: "ignore",
		}).pipe(Effect.option);
		if (packageFile._tag === "None") {
			reject({reason: "package-name-invalid"});
			continue;
		}
		packageIdentity = packageFile.value.name;
		if (packageFile.value.tuval === undefined) continue;
		const packageName = packageIdentity;
		const manifest = yield* Schema.decodeUnknownEffect(TuvalManifest)(packageFile.value.tuval, {
			onExcessProperty: "error",
		}).pipe(Effect.option);
		if (manifest._tag === "None") {
			reject({reason: "manifest-invalid"});
			continue;
		}
		const canonicalRoot = yield* fs.realPath(root.baseDir).pipe(Effect.option);
		if (canonicalRoot._tag === "None") {
			reject({reason: "package-root-unavailable"});
			continue;
		}
		const packageFrontend: Array<FrontendContribution> = [];
		const packageAssetFiles = new Map<string, string>();
		const packageKeys = new Set<string>();
		let invalid: ContributionRejection | undefined;
		for (const {kind, entry} of manifestFrontend(manifest.value)) {
			const key = `${kind}:${entry.key}`;
			const context = {kind, key: entry.key};
			if (packageKeys.has(key)) {
				invalid = {reason: "duplicate-key", ...context};
				break;
			}
			if (keys.has(key)) {
				invalid = {reason: "shadowed-key", ...context};
				break;
			}
			const asset = yield* canonicalFileInside(fs, path, canonicalRoot.value, entry.asset).pipe(
				Effect.option,
			);
			if (asset._tag === "None" || asset.value === undefined) {
				invalid = {reason: "asset-unavailable", ...context};
				break;
			}
			const assetUrl = contributionAssetUrl(frontend.length + packageFrontend.length);
			packageKeys.add(key);
			packageAssetFiles.set(assetUrl, asset.value);
			packageFrontend.push({kind, key: entry.key, asset: assetUrl, packageName, source});
		}
		if (invalid !== undefined) {
			reject(invalid);
			continue;
		}
		const packageBackend: Array<BackendContribution> = [];
		for (const entry of manifest.value.backend ?? []) {
			const modulePath = yield* canonicalFileInside(
				fs,
				path,
				canonicalRoot.value,
				entry.module,
			).pipe(Effect.option);
			if (modulePath._tag === "None" || modulePath.value === undefined) {
				invalid = {reason: "backend-module-unavailable"};
				break;
			}
			const canonicalModulePath = modulePath.value;
			const loaded = yield* Effect.tryPromise({
				try: () => import(pathToFileURL(canonicalModulePath).href),
				catch: (cause) =>
					new ContributionStartupFailure({
						packageName,
						message: "Backend contribution module failed to load",
						cause,
					}),
			}).pipe(Effect.option);
			if (loaded._tag === "None") {
				invalid = {reason: "backend-module-unavailable"};
				break;
			}
			const factory = loaded.value[entry.export];
			if (typeof factory !== "function") {
				invalid = {reason: "backend-export-not-factory"};
				break;
			}
			const layer = yield* Effect.try({
				try: () => factory(),
				catch: (cause) =>
					new ContributionStartupFailure({
						packageName,
						message: "Backend contribution factory failed",
						cause,
					}),
			}).pipe(Effect.option);
			if (layer._tag === "None") {
				invalid = {reason: "backend-export-not-layer"};
				break;
			}
			const decodedLayer = Schema.decodeUnknownOption(BackendLayer)(layer.value);
			if (decodedLayer._tag === "None") {
				invalid = {reason: "backend-export-not-layer"};
				break;
			}
			packageBackend.push({
				packageName,
				source,
				module: canonicalModulePath,
				exportName: entry.export,
				layer: decodedLayer.value,
			});
		}
		if (invalid !== undefined) {
			reject(invalid);
			continue;
		}
		for (const key of packageKeys) keys.add(key);
		for (const [assetUrl, assetFile] of packageAssetFiles) assetFiles.set(assetUrl, assetFile);
		frontend.push(...packageFrontend);
		backend.push(...packageBackend);
	}
	return {
		contractVersion: 1,
		backend,
		frontend,
		assetFiles,
		diagnostics,
	} satisfies TuvalContributionCatalog;
});

export const buildPackageBackendLayers = Effect.fn("TuvalPackages.buildBackend")(function* (
	catalog: TuvalContributionCatalog,
	extensionUI?: ExtensionUIService,
) {
	const bridge = extensionUI ?? makeExtensionUI();
	const diagnostics: Array<ContributionDiagnostic> = [];
	for (const contribution of catalog.backend) {
		const layer = contribution.layer.pipe(
			Layer.provide(
				Layer.succeed(PackageExtensionUI, packageExtensionUI(contribution.packageName, bridge)),
			),
		);
		const built = yield* Effect.result(
			Layer.build(layer).pipe(
				Effect.mapError(
					(cause) =>
						new ContributionStartupFailure({
							packageName: contribution.packageName,
							message: "Backend contribution layer failed to build",
							cause,
						}),
				),
			),
		);
		if (Result.isFailure(built)) {
			diagnostics.push({
				packageName: contribution.packageName,
				reason: "backend-layer-build-failed",
				message: diagnosticMessage({reason: "backend-layer-build-failed"}),
			});
		}
	}
	return diagnostics;
});

export const emitContributionCatalog = (catalog: TuvalContributionCatalog) => ({
	contractVersion: catalog.contractVersion,
	frontend: catalog.frontend.map(({kind, key, asset, packageName}) => ({
		kind,
		key,
		asset,
		packageName,
	})),
	diagnostics: catalog.diagnostics.map((diagnostic) => ({...diagnostic})),
});
