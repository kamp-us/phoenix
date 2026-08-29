import {pathToFileURL} from "node:url";
import {
	DefaultPackageManager,
	getAgentDir,
	type PackageManager,
	type PathMetadata,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {Effect, FileSystem, Layer, Path, Schema} from "effect";
import {parsePackageJson} from "./package-json.js";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
export const PublicPackageIdentity = NonEmptyString.pipe(
	Schema.brand("TuvalPublicPackageIdentity"),
);
export type PublicPackageIdentity = typeof PublicPackageIdentity.Type;
const ContributionKey = Schema.String.check(
	Schema.isPattern(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
);

class BackendEntry extends Schema.Class<BackendEntry>("TuvalBackendEntry")({
	module: NonEmptyString,
	export: NonEmptyString,
}) {}

class FrontendEntry extends Schema.Class<FrontendEntry>("TuvalFrontendEntry")({
	key: ContributionKey,
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
	readonly key: string;
	readonly asset: string;
	readonly packageName: PublicPackageIdentity;
	readonly source: string;
}

type BackendLayer = Layer.Layer<unknown, unknown, never>;

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

export interface ContributionDiagnostic {
	readonly packageName: PublicPackageIdentity;
	readonly source: string;
	readonly message: string;
}

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

const resolveInside = (
	path: Pick<typeof import("node:path"), "resolve" | "relative" | "isAbsolute">,
	baseDir: string,
	entry: string,
) => {
	const resolved = path.resolve(baseDir, entry);
	const relative = path.relative(baseDir, resolved);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
		? resolved
		: undefined;
};

const manifestFrontend = (manifest: TuvalManifest) => [
	...(manifest.frontend?.nodes ?? []).map((entry) => ({kind: "node" as const, entry})),
	...(manifest.frontend?.edges ?? []).map((entry) => ({kind: "edge" as const, entry})),
	...(manifest.frontend?.panels ?? []).map((entry) => ({kind: "panel" as const, entry})),
];

const contributionAssetUrl = (index: number) => `/api/contribution-assets/v1-${index}.js`;

const fallbackPackageIdentity = (metadata: PathMetadata, index: number) =>
	PublicPackageIdentity.make(`unidentified-${metadata.scope}-package-${index + 1}`);

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
		const reject = (message: string) => {
			diagnostics.push({packageName: packageIdentity, source, message});
		};
		const text = yield* fs.readFileString(packageJsonPath).pipe(Effect.option);
		if (text._tag === "None") {
			reject("package.json is unreadable");
			continue;
		}
		const parsedJson = parsePackageJson(text.value);
		if (parsedJson._tag === "Failed") {
			reject("package.json is not valid JSON");
			continue;
		}
		const packageFile = yield* Schema.decodeUnknownEffect(PackageFile)(parsedJson.value, {
			onExcessProperty: "ignore",
		}).pipe(Effect.option);
		if (packageFile._tag === "None") {
			reject("package.json has no valid package name");
			continue;
		}
		packageIdentity = packageFile.value.name;
		if (packageFile.value.tuval === undefined) continue;
		const packageName = packageIdentity;
		const manifest = yield* Schema.decodeUnknownEffect(TuvalManifest)(packageFile.value.tuval, {
			onExcessProperty: "error",
		}).pipe(Effect.option);
		if (manifest._tag === "None") {
			reject("Tuval manifest is invalid or uses an unsupported contract");
			continue;
		}
		const packageFrontend: Array<FrontendContribution> = [];
		const packageAssetFiles = new Map<string, string>();
		const packageKeys = new Set<string>();
		let invalid: string | undefined;
		for (const {kind, entry} of manifestFrontend(manifest.value)) {
			const key = `${kind}:${entry.key}`;
			if (packageKeys.has(key)) {
				invalid = `duplicate ${kind} key ${entry.key} inside package`;
				break;
			}
			if (keys.has(key)) {
				invalid = `${kind} key ${entry.key} is shadowed by a higher-precedence package`;
				break;
			}
			const asset = resolveInside(path, root.baseDir, entry.asset);
			if (asset === undefined || !(yield* fs.exists(asset))) {
				invalid = `${kind} asset ${entry.asset} is missing or outside the package`;
				break;
			}
			const assetUrl = contributionAssetUrl(frontend.length + packageFrontend.length);
			packageKeys.add(key);
			packageAssetFiles.set(assetUrl, asset);
			packageFrontend.push({kind, key: entry.key, asset: assetUrl, packageName, source});
		}
		if (invalid !== undefined) {
			reject(invalid);
			continue;
		}
		const packageBackend: Array<BackendContribution> = [];
		for (const entry of manifest.value.backend ?? []) {
			const modulePath = resolveInside(path, root.baseDir, entry.module);
			if (modulePath === undefined || !(yield* fs.exists(modulePath))) {
				invalid = `backend module ${entry.module} is missing or outside the package`;
				break;
			}
			const loaded = yield* Effect.tryPromise({
				try: () => import(pathToFileURL(modulePath).href),
				catch: (cause) =>
					new ContributionStartupFailure({
						packageName,
						message: `Backend module ${entry.module} failed to load`,
						cause,
					}),
			});
			const factory = loaded[entry.export];
			if (typeof factory !== "function") {
				invalid = `backend export ${entry.export} is not a factory`;
				break;
			}
			const layer = yield* Effect.try({
				try: () => factory(),
				catch: (cause) =>
					new ContributionStartupFailure({
						packageName,
						message: `Backend factory ${entry.export} failed`,
						cause,
					}),
			});
			const decodedLayer = Schema.decodeUnknownOption(BackendLayer)(layer);
			if (decodedLayer._tag === "None") {
				invalid = `backend export ${entry.export} did not return an Effect Layer`;
				break;
			}
			packageBackend.push({
				packageName,
				source,
				module: modulePath,
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
) {
	for (const contribution of catalog.backend) {
		yield* Layer.build(contribution.layer).pipe(
			Effect.mapError(
				(cause) =>
					new ContributionStartupFailure({
						packageName: contribution.packageName,
						message: `Backend layer ${contribution.exportName} failed to build`,
						cause,
					}),
			),
		);
	}
});

export const emitContributionCatalog = (catalog: TuvalContributionCatalog) => ({
	contractVersion: catalog.contractVersion,
	frontend: catalog.frontend.map(({kind, key, asset, packageName}) => ({
		kind,
		key,
		asset,
		packageName,
	})),
	diagnostics: catalog.diagnostics.map(({packageName, message}) => ({packageName, message})),
});
