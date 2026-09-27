/**
 * The decision core of the packed desk's outside proof (#9690): the packed `@kampus/tuval` is what
 * the issue says it is, and the desk an outside author runs from it resolves nothing inside the
 * phoenix checkout and exactly one `@kampus/tuval-sdk`. The bin in `./outside.bin.ts` runs the steps;
 * this module judges what they read. Every path it is handed is already canonical, so a `/var` and a
 * `/private/var` spelling of one file compare equal.
 */

import {isAbsolute, relative} from "node:path";
import {fileURLToPath} from "node:url";
import {BIN_NAME, PUBLISHED_NAME, SDK_PACKAGE} from "./manifest.ts";

const within = (root: string, path: string): boolean => {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Where the author's folder is about to be. Under the checkout, Node would walk up into it. */
export type Placement =
	| {readonly _tag: "Outside"}
	| {readonly _tag: "Inside"; readonly path: string};

export const placement = (checkout: string, work: string): Placement =>
	within(checkout, work) ? {_tag: "Inside", path: work} : {_tag: "Outside"};

/** A `.ts` file an exports map could name, which Node will not load from `node_modules`; not a `.d.ts`. */
const TYPESCRIPT_SOURCE = /(?<!\.d)\.[cm]?tsx?$/;

/** Every file target an `exports` map names, however deeply it nests conditions. */
const exportTargets = (exports: unknown): ReadonlyArray<string> => {
	if (typeof exports === "string") return [exports];
	if (exports === null || typeof exports !== "object") return [];
	return Object.values(exports).flatMap(exportTargets);
};

interface PackedManifest {
	readonly name?: unknown;
	readonly bin?: unknown;
	readonly exports?: unknown;
	readonly dependencies?: Readonly<Record<string, unknown>>;
	readonly bundledDependencies?: unknown;
	readonly bundleDependencies?: unknown;
}

/** What is wrong with the packed desk, one line each; empty when nothing is. */
export const packedDeskFindings = (
	manifestJson: string,
	entries: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const manifest = JSON.parse(manifestJson) as PackedManifest;
	const findings: Array<string> = [];
	if (manifest.name !== PUBLISHED_NAME) {
		findings.push(`it packs as ${String(manifest.name)}, not ${PUBLISHED_NAME}`);
	}
	const bin =
		manifest.bin !== null && typeof manifest.bin === "object"
			? (manifest.bin as Readonly<Record<string, unknown>>)[BIN_NAME]
			: undefined;
	if (typeof bin !== "string") findings.push(`it declares no \`${BIN_NAME}\` bin`);
	else if (!entries.includes(`package/${bin.replace(/^\.\//, "")}`)) {
		findings.push(`its \`${BIN_NAME}\` bin names ${bin}, which the tarball does not hold`);
	}
	if (manifest.exports === undefined) findings.push("it has no exports map");
	for (const target of exportTargets(manifest.exports)) {
		if (TYPESCRIPT_SOURCE.test(target)) findings.push(`its exports map names ${target}`);
	}
	const sdk = manifest.dependencies?.[SDK_PACKAGE];
	if (typeof sdk !== "string" || !/^\d/.test(sdk)) {
		findings.push(`it does not depend on a published ${SDK_PACKAGE} (found ${String(sdk)})`);
	}
	if (manifest.bundledDependencies !== undefined || manifest.bundleDependencies !== undefined) {
		findings.push("it bundles dependencies into the tarball");
	}
	for (const entry of entries) {
		if (entry.split("/").includes("node_modules")) findings.push(`the tarball holds ${entry}`);
	}
	return findings;
};

/**
 * The effect version the packed SDK pins. The author installs that exact version beside it, as the
 * SDK's README tells an author to, so the author's schemas and the SDK's share one copy.
 */
export const effectPin = (packedSdkManifest: string): string => {
	const manifest = JSON.parse(packedSdkManifest) as {dependencies?: Record<string, string>};
	const pin = manifest.dependencies?.effect;
	if (pin === undefined || !/^\d/.test(pin)) {
		throw new Error(`the packed SDK pins no published effect version (found ${String(pin)})`);
	}
	return pin;
};

/**
 * The files the resolve hook logged; `node:` builtins and other schemes name no file. A reload's
 * generation stamp rides the URL's query, which names no other file.
 */
export const resolvedFiles = (log: string): ReadonlyArray<string> => [
	...new Set(
		log
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("file:"))
			.map((url) => fileURLToPath(new URL(url))),
	),
];

const SDK_SEGMENT = `/node_modules/${SDK_PACKAGE}/`;
const DESK_SEGMENT = `/node_modules/${PUBLISHED_NAME}/`;

/** The directory of the SDK copy a file belongs to, or `undefined` for a file of no SDK copy. */
const sdkRootOf = (path: string): string | undefined => {
	const at = path.lastIndexOf(SDK_SEGMENT);
	return at === -1 ? undefined : path.slice(0, at + SDK_SEGMENT.length - 1);
};

export type Verdict =
	| {readonly _tag: "Clean"; readonly files: number; readonly sdk: string}
	| {readonly _tag: "Leaked"; readonly paths: ReadonlyArray<string>}
	| {readonly _tag: "TwoSdks"; readonly roots: ReadonlyArray<string>}
	/** The run loaded no file of the installed desk, or none of the SDK, so it proves nothing about either. */
	| {readonly _tag: "Unobserved"; readonly what: string};

/** Judge every file the desk's processes resolved. */
export const judge = (checkout: string, files: ReadonlyArray<string>): Verdict => {
	const leaked = files.filter((path) => within(checkout, path));
	if (leaked.length > 0) return {_tag: "Leaked", paths: leaked};
	if (!files.some((path) => path.includes(DESK_SEGMENT))) {
		return {_tag: "Unobserved", what: `the installed ${PUBLISHED_NAME}`};
	}
	const roots = [...new Set(files.flatMap((path) => sdkRootOf(path) ?? []))].sort();
	const [sdk, ...others] = roots;
	if (sdk === undefined) return {_tag: "Unobserved", what: `the installed ${SDK_PACKAGE}`};
	if (others.length > 0) return {_tag: "TwoSdks", roots};
	return {_tag: "Clean", files: files.length, sdk};
};

export const render = (verdict: Verdict): string => {
	switch (verdict._tag) {
		case "Clean":
			return `desk outside proof: clean — the desk resolved ${verdict.files} files, none inside the checkout, and one ${SDK_PACKAGE} at ${verdict.sdk}.`;
		case "Leaked":
			return [
				"desk outside proof: the desk resolved files inside the phoenix checkout:",
				...verdict.paths.map((path) => `  ${path}`),
			].join("\n");
		case "TwoSdks":
			return [
				`desk outside proof: the desk loaded more than one ${SDK_PACKAGE}:`,
				...verdict.roots.map((root) => `  ${root}`),
			].join("\n");
		case "Unobserved":
			return `desk outside proof: the desk loaded no file of ${verdict.what}, so it proves nothing.`;
	}
};
