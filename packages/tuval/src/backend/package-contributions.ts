import {pathToFileURL} from "node:url";
import {
	DefaultPackageManager,
	getAgentDir,
	type PackageManager,
	type PathMetadata,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {Effect, FileSystem, Layer, Path, Schema} from "effect";
import {
	type ExtensionUIService,
	makeExtensionUI,
	PackageExtensionUI,
	packageExtensionUI,
} from "./extension-ui.js";
import {parsePackageJson} from "./package-json.js";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
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
	name: Schema.String,
	tuval: Schema.optionalKey(Schema.Unknown),
}) {}

export type ContributionKind = "node" | "edge" | "panel";

export interface FrontendContribution {
	readonly kind: ContributionKind;
	readonly key: string;
	readonly asset: string;
	readonly packageName: string;
	readonly source: string;
}

type BackendLayer = Layer.Layer<never, unknown, PackageExtensionUI>;

const BackendLayer = Schema.declare<BackendLayer>((value): value is BackendLayer =>
	Layer.isLayer(value),
);

export interface BackendContribution {
	readonly packageName: string;
	readonly source: string;
	readonly module: string;
	readonly exportName: string;
	readonly layer: BackendLayer;
}

export interface ContributionDiagnostic {
	readonly packageName: string;
	readonly source: string;
	readonly message: string;
}

export interface TuvalContributionCatalog {
	readonly contractVersion: 1;
	readonly backend: ReadonlyArray<BackendContribution>;
	readonly frontend: ReadonlyArray<FrontendContribution>;
	readonly diagnostics: ReadonlyArray<ContributionDiagnostic>;
}

export class ContributionStartupFailure extends Schema.TaggedErrorClass<ContributionStartupFailure>()(
	"tuval/ContributionStartupFailure",
	{packageName: Schema.String, message: Schema.String, cause: Schema.optionalKey(Schema.Defect())},
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
				packageName: "pi",
				message: "Pi package resolution failed",
				cause,
			}),
	});
	const backend: Array<BackendContribution> = [];
	const frontend: Array<FrontendContribution> = [];
	const diagnostics: Array<ContributionDiagnostic> = [];
	const keys = new Set<string>();

	for (const root of packageRoots(resolved.extensions)) {
		const packageJsonPath = path.join(root.baseDir, "package.json");
		const source = root.metadata.source;
		const reject = (packageName: string, message: string) => {
			diagnostics.push({packageName, source, message});
		};
		const text = yield* fs.readFileString(packageJsonPath).pipe(Effect.option);
		if (text._tag === "None") {
			reject(source, "package.json is unreadable");
			continue;
		}
		const parsedJson = parsePackageJson(text.value);
		if (parsedJson._tag === "Failed") {
			reject(source, "package.json is not valid JSON");
			continue;
		}
		const packageFile = yield* Schema.decodeUnknownEffect(PackageFile)(parsedJson.value, {
			onExcessProperty: "ignore",
		}).pipe(Effect.option);
		if (packageFile._tag === "None") {
			reject(source, "package.json has no valid package name");
			continue;
		}
		if (packageFile.value.tuval === undefined) continue;
		const packageName = packageFile.value.name;
		const manifest = yield* Schema.decodeUnknownEffect(TuvalManifest)(packageFile.value.tuval, {
			onExcessProperty: "error",
		}).pipe(Effect.option);
		if (manifest._tag === "None") {
			reject(packageName, "Tuval manifest is invalid or uses an unsupported contract");
			continue;
		}
		const packageFrontend: Array<FrontendContribution> = [];
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
			packageKeys.add(key);
			packageFrontend.push({kind, key: entry.key, asset: asset as string, packageName, source});
		}
		if (invalid !== undefined) {
			reject(packageName, invalid);
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
			reject(packageName, invalid);
			continue;
		}
		for (const key of packageKeys) keys.add(key);
		frontend.push(...packageFrontend);
		backend.push(...packageBackend);
	}
	return {contractVersion: 1, backend, frontend, diagnostics} satisfies TuvalContributionCatalog;
});

export const buildPackageBackendLayers = Effect.fn("TuvalPackages.buildBackend")(function* (
	catalog: TuvalContributionCatalog,
	extensionUI?: ExtensionUIService,
) {
	const bridge = extensionUI ?? makeExtensionUI();
	for (const contribution of catalog.backend) {
		const layer = contribution.layer.pipe(
			Layer.provide(
				Layer.succeed(PackageExtensionUI, packageExtensionUI(contribution.packageName, bridge)),
			),
		);
		yield* Layer.build(layer).pipe(
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
	frontend: catalog.frontend.map(({kind, key, asset, packageName, source}) => ({
		kind,
		key,
		asset,
		packageName,
		source,
	})),
	diagnostics: catalog.diagnostics,
});
