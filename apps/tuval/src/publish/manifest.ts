/**
 * What the packed desk is (#9690, founder ruling #9668 R6.1 and the #9646 naming ruling): the app
 * stays `@kampus-apps/tuval` in the workspace and packs as `@kampus/tuval`, with a `tuval` bin. The
 * two names differ because `pnpm pack` reads its manifest from `publishConfig.directory`, and
 * `./build.bin.ts` writes that manifest there, composed here from the app's own.
 *
 * The workspace packages the desk runs on are bundled into it, because none of them is published.
 * `@kampus/tuval-sdk` is the one exception: it is a regular dependency, so the desk and every program
 * resolve one copy of it (ruling #9668 R2.2). Every other package the bundles still import is a
 * dependency, at the spec the workspace already declares for it.
 */

/** The name the desk packs and publishes under. */
export const PUBLISHED_NAME = "@kampus/tuval";

/** The command the packed desk installs. */
export const BIN_NAME = "tuval";

/** Where that command's module sits in the packed directory. */
export const BIN_PATH = "./server/bin.js";

/** The SDK: never bundled, always resolved from where the desk is installed. */
export const SDK_PACKAGE = "@kampus/tuval-sdk";

/**
 * The packages a program's window shares with the page, which the page bundle leaves as imports so
 * the page server resolves each once for both. A second React breaks a module window's hooks at
 * first paint, and a second Effect or SDK breaks service lookups — the reason the page server
 * dedupes the first three (`../page/dev-server.ts`).
 */
export const SHARED_WITH_PROGRAMS: ReadonlySet<string> = new Set([
	"react",
	"react-dom",
	"effect",
	SDK_PACKAGE,
]);

/**
 * Packages the desk does not import but still pins, at their workspace catalog version. The
 * workspace holds the Effect family on one release through pnpm `overrides`, and npm never applies
 * a dependency's overrides: `@effect/platform-node` asks for a `^` range of
 * `@effect/platform-node-shared`, which outside the workspace resolves to a newer release built
 * against a newer Effect than the one the desk and the SDK share, and the desk fails to start.
 */
export const PINNED_TRANSITIVE: ReadonlyArray<string> = ["@effect/platform-node-shared"];

/** The page server's generated modules (`../page/dev-server.ts`): answered at run time, never built. */
const VIRTUAL_PREFIX = "virtual:tuval/";

/**
 * The package a specifier imports, or `null` for one that names no package: a relative or absolute
 * path, a `node:` builtin, a virtual module, or a bundler-internal `\0` id.
 */
export const packageOf = (specifier: string): string | null => {
	if (specifier === "" || specifier.startsWith(".") || specifier.startsWith("/")) return null;
	if (specifier.startsWith("\0") || specifier.includes(":")) return null;
	const parts = specifier.split("/");
	if (specifier.startsWith("@")) {
		const [scope, name] = parts;
		return scope !== undefined && name !== undefined && name !== "" ? `${scope}/${name}` : null;
	}
	return parts[0] ?? null;
};

/** The page bundle leaves an import out when a program's window has to share it, or when it is generated. */
export const pageExternal = (specifier: string): boolean => {
	if (specifier.startsWith(VIRTUAL_PREFIX)) return true;
	const name = packageOf(specifier);
	return name !== null && SHARED_WITH_PROGRAMS.has(name);
};

/** The server bundle keeps every workspace package it reaches and imports every other one. */
export const serverExternal =
	(bundled: ReadonlySet<string>) =>
	(specifier: string): boolean => {
		const name = packageOf(specifier);
		return name !== null && !bundled.has(name);
	};

/** The slice of a `package.json` this module reads. */
export interface Manifest {
	readonly name: string;
	readonly version: string;
	readonly description?: string;
	readonly license?: string;
	readonly repository?: unknown;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly devDependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
}

const isWorkspaceSpec = (spec: string): boolean => spec.startsWith("workspace:");

/** The workspace packages `manifest` depends on at run time that the desk bundles: all but the SDK. */
export const bundledEdges = (manifest: Manifest): ReadonlyArray<string> =>
	Object.entries(manifest.dependencies ?? {})
		.filter(([name, spec]) => isWorkspaceSpec(spec) && name !== SDK_PACKAGE)
		.map(([name]) => name);

/** A module the bundler read from inside `root`: how a bundled copy of the SDK is recognised. */
export const readFrom = (moduleIds: Iterable<string>, root: string): ReadonlyArray<string> => {
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return [...new Set(moduleIds)].filter((id) => id.startsWith(prefix)).sort();
};

export type Composed =
	| {readonly _tag: "Composed"; readonly manifest: Readonly<Record<string, unknown>>}
	/** A package the bundles import that no manifest behind them declares, so no spec is known for it. */
	| {readonly _tag: "Undeclared"; readonly packages: ReadonlyArray<string>}
	/** A workspace package a bundle imports rather than carries: installed from npm, it would not resolve. */
	| {readonly _tag: "Unbundled"; readonly packages: ReadonlyArray<string>};

export interface ComposeInput {
	readonly app: Manifest;
	/** The manifests of the workspace packages the bundles carry. */
	readonly bundled: ReadonlyArray<Manifest>;
	/** Every package either bundle imports. */
	readonly imports: Iterable<string>;
}

/**
 * The packed desk's manifest. Each imported package takes the spec the app declares for it, or
 * failing that the one a bundled package declares; the specs stay `catalog:` and `workspace:`, which
 * `pnpm pack` resolves to the versions the lockfile holds.
 */
export const composeManifest = ({app, bundled, imports}: ComposeInput): Composed => {
	const declared = [app.dependencies, app.devDependencies].concat(
		bundled.flatMap((manifest) => [manifest.dependencies, manifest.peerDependencies]),
	);
	const specOf = (name: string): string | undefined =>
		declared.map((specs) => specs?.[name]).find((spec) => spec !== undefined);
	const names = [...new Set(imports)].sort();
	const unbundled = names.filter(
		(name) =>
			name !== SDK_PACKAGE && specOf(name) !== undefined && isWorkspaceSpec(specOf(name) ?? ""),
	);
	if (unbundled.length > 0) return {_tag: "Unbundled", packages: unbundled};
	const undeclared = names.filter((name) => specOf(name) === undefined);
	if (undeclared.length > 0) return {_tag: "Undeclared", packages: undeclared};
	const dependencies = Object.fromEntries(
		[
			...names.map((name) => [name, specOf(name) ?? ""] as const),
			...PINNED_TRANSITIVE.filter((name) => !names.includes(name)).map(
				(name) => [name, "catalog:"] as const,
			),
		].sort(([a], [b]) => a.localeCompare(b)),
	);
	return {
		_tag: "Composed",
		manifest: {
			name: PUBLISHED_NAME,
			version: app.version,
			...(app.description === undefined ? {} : {description: app.description}),
			...(app.license === undefined ? {} : {license: app.license}),
			...(app.repository === undefined ? {} : {repository: app.repository}),
			type: "module",
			bin: {[BIN_NAME]: BIN_PATH},
			exports: {"./package.json": "./package.json"},
			dependencies,
		},
	};
};

export const renderComposed = (composed: Exclude<Composed, {_tag: "Composed"}>): string => {
	switch (composed._tag) {
		case "Undeclared":
			return `the packed desk imports ${composed.packages.join(", ")}, which no manifest behind it declares`;
		case "Unbundled":
			return `the packed desk imports the workspace package(s) ${composed.packages.join(", ")} instead of carrying them`;
	}
};
