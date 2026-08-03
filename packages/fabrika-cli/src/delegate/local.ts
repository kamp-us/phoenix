/**
 * Whether the repo root holds an installed copy of this package, and where.
 *
 * Resolution is **Node's own**, from the root manifest: `createRequire(<root>/package.json)
 * .resolve('@kampus/fabrika-cli/package.json')`. That single call already covers pnpm's symlinked
 * `.pnpm` layout, hoisting to a non-ancestor and unusual nesting — all of which a hand-built
 * `node_modules/@kampus/fabrika-cli` path join gets wrong. turbo needs four search strategies only
 * because it ships prebuilt native binaries per platform; a pure-TS CLI has exactly one package, so
 * there is **no** platform-package resolution here (turbo `main` @ `c6fbc97`,
 * `crates/turborepo-shim/local_turbo_state.rs`).
 *
 * The probe is total over three outcomes and **none of them is a throw**: found, absent, or corrupt.
 * Corrupt is deliberately not fatal — turbo's own note at the equivalent branch is *"we can choose
 * to operate this aggressively because the _worst_ outcome is that we run global turbo"* — but it is
 * never silent either: the caller warns loudly and names the reason.
 */
import {Effect, FileSystem, Path} from "effect";
import {readFile} from "../io/fs.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {resolvePackageManifest} from "./node-resolve.ts";

/**
 * The npm name the probe resolves, and the bin key inside that package's manifest.
 *
 * They differ on purpose: resolution is by **package** name, while the command a caller types — and
 * therefore the manifest's `bin` key — is `fabrika` (#4784).
 */
export const PACKAGE_NAME = "@kampus/fabrika-cli";
export const BIN_NAME = "fabrika";

/** A repo-local install: a real installed package with a declared entry point and a version. */
export interface LocalInstall {
	/** The install's real path — symlinks resolved, so it compares against a running package root. */
	readonly packageRoot: string;
	readonly manifestPath: string;
	/** Absolute and real, resolved from the manifest's own `bin` field against {@link packageRoot}. */
	readonly binPath: string;
	readonly version: string;
}

export type LocalProbe =
	| {readonly _tag: "found"; readonly install: LocalInstall}
	| {readonly _tag: "absent"}
	| {readonly _tag: "corrupt"; readonly reason: string};

/**
 * The `version` and resolved bin path declared by a manifest, or why it cannot be trusted.
 *
 * Pure over the manifest text, so every corruption shape is testable without an install on disk.
 */
export const readInstallManifest = (
	path: Path.Path,
	manifestPath: string,
	text: string,
): {readonly version: string; readonly bin: string} | {readonly corrupt: string} => {
	const manifest = parseJson(text);
	if (!isRecord(manifest)) return {corrupt: `${manifestPath} is not valid JSON`};
	if (typeof manifest.version !== "string" || manifest.version === "")
		return {corrupt: `${manifestPath} declares no "version"`};
	const bin = manifest.bin;
	const entry = typeof bin === "string" ? bin : isRecord(bin) ? bin[BIN_NAME] : undefined;
	if (typeof entry !== "string") return {corrupt: `${manifestPath} declares no "${BIN_NAME}" bin`};
	return {version: manifest.version, bin: path.resolve(path.dirname(manifestPath), entry)};
};

/**
 * Probe `repoRoot` for an installed copy of this package.
 *
 * The `E` channel carries only failures the caller must *stop* on — a manifest that exists but
 * cannot be read. Everything a repo can plausibly get wrong (nothing installed, a half-written
 * manifest, an install whose real path is gone) resolves to `absent`/`corrupt` and is warned about.
 */
export const probeLocalInstall = (
	repoRoot: string,
): Effect.Effect<LocalProbe, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const fs = yield* FileSystem.FileSystem;
		const resolved = resolvePackageManifest(path.join(repoRoot, "package.json"), PACKAGE_NAME);
		if (resolved._tag !== "resolved") return resolved;
		const {manifestPath} = resolved;

		const text = yield* readFile(manifestPath).pipe(Effect.catch(() => Effect.succeed(undefined)));
		if (text === undefined)
			return {_tag: "corrupt", reason: `${manifestPath} could not be read`} as const;
		const manifest = readInstallManifest(path, manifestPath, text);
		if ("corrupt" in manifest) return {_tag: "corrupt", reason: manifest.corrupt} as const;

		// Real paths on both ends of the eventual self-check: pnpm links a workspace package into
		// `node_modules`, so the symlink and its target are one install under two names. Comparing the
		// unresolved name against a running package root would make a repo-local copy delegate to
		// itself forever.
		const soften = Effect.catch(() => Effect.succeed(undefined));
		const packageRoot = yield* fs.realPath(path.dirname(manifestPath)).pipe(soften);
		const binPath = yield* fs.realPath(manifest.bin).pipe(soften);
		if (packageRoot === undefined || binPath === undefined)
			return {
				_tag: "corrupt",
				reason: `${manifestPath} points at a bin that is not on disk (${manifest.bin})`,
			} as const;
		return {
			_tag: "found",
			install: {packageRoot, manifestPath, binPath, version: manifest.version},
		} as const;
	});

/**
 * The version the root manifest *declares* for this package, in either dependency block.
 *
 * The warning quotes it beside the global's own version, so a developer standing in a repo that
 * pinned a version it never installed can see both halves of the mismatch at once.
 */
export const declaredVersion = (
	repoRoot: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const text = yield* readFile(path.join(repoRoot, "package.json")).pipe(
			Effect.orElseSucceed(() => ""),
		);
		const manifest = parseJson(text);
		if (!isRecord(manifest)) return undefined;
		const blocks = [manifest.dependencies, manifest.devDependencies].filter(isRecord);
		const found = blocks.map((block) => block[PACKAGE_NAME]).find((v) => typeof v === "string");
		return typeof found === "string" ? found : undefined;
	});
