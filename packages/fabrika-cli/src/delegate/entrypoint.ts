/**
 * The invocation a spawned shell should run this CLI's verbs through — the value `lane brief` puts
 * in a brief's `fabrika:` field (#6012).
 *
 * The rules used to name phoenix's own `packages/fabrika-cli/src/bin.ts` as a literal, which is a
 * `MODULE_NOT_FOUND` in every repo that installs fabrika rather than developing it. What replaces it
 * is not one shape but a rule over two, and the discriminator is the one `delegate/root.ts` already
 * owns — is the running copy a checkout of this package's own repo, or an installed artifact?
 *
 * - **A checkout** answers repo-relative, because the shell stands in its own worktree of that same
 *   repo and must run *its* copy of the source. An absolute path would send it to the driver's
 *   checkout, which is the #5679 defect the binstub ban exists for, arriving by another door.
 * - **An installed artifact** answers absolute, because a worktree cut from a repo carries no
 *   `node_modules` of its own and a repo-relative `node_modules/…` path would not exist there.
 */
import {fileURLToPath} from "node:url";
import {Effect, FileSystem, Path} from "effect";
import {readFile} from "../io/fs.ts";
import {readInstallManifest} from "./local.ts";
import {originOf, type SelfOrigin} from "./root.ts";

/** This module's own directory — the anchor the running package root is derived from. */
const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Which of the two shapes the entrypoint takes, given where the running copy lives.
 *
 * Pure, so the rule is testable against a non-phoenix layout without an install on disk — which is
 * the regression this whole module exists to keep out of a consuming repo's maiden run.
 */
export const entrypointFor = (path: Path.Path, origin: SelfOrigin, binPath: string): string => {
	if (origin._tag === "no-checkout") return binPath;
	const rel = path.relative(origin.root, binPath);
	// A relative path is only usable when it stays inside the tree the shell's worktree mirrors.
	return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? binPath : rel;
};

export type EntrypointRead =
	| {readonly _tag: "Entrypoint"; readonly entrypoint: string}
	| {readonly _tag: "Unresolved"; readonly reason: string};

/**
 * This run's own entrypoint, resolved from the running package's manifest rather than from
 * `process.argv[1]`.
 *
 * `argv[1]` is the *shim* when a pnpm binstub was typed and no delegation happened, and a shim is a
 * shell script `node` cannot execute. The manifest's `bin` field is the same value in both worlds —
 * `./src/bin.ts` in a checkout, `./dist/bin.js` once published — so it is the one read that answers
 * correctly however this process was started.
 */
export const resolveEntrypoint = (
	moduleDir: string = MODULE_DIR,
): Effect.Effect<EntrypointRead, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const fs = yield* FileSystem.FileSystem;
		const soften = Effect.catch(() => Effect.succeed(undefined));
		const packageRoot = yield* fs.realPath(path.resolve(moduleDir, "..", "..")).pipe(soften);
		if (packageRoot === undefined) {
			return {_tag: "Unresolved", reason: "this fabrika's own package root is not on disk"};
		}
		const manifestPath = path.join(packageRoot, "package.json");
		const text = yield* readFile(manifestPath).pipe(soften);
		if (text === undefined) {
			return {_tag: "Unresolved", reason: `${manifestPath} could not be read`};
		}
		const manifest = readInstallManifest(path, manifestPath, text);
		if ("corrupt" in manifest) return {_tag: "Unresolved", reason: manifest.corrupt};
		const binPath = yield* fs.realPath(manifest.bin).pipe(soften);
		if (binPath === undefined) {
			return {
				_tag: "Unresolved",
				reason: `${manifestPath} points at a bin that is not on disk (${manifest.bin})`,
			};
		}
		// Never softened to `no-checkout`: an unreadable ancestor would answer with the driver's own
		// absolute path, which is exactly the cross-checkout invocation #5679 bans, arriving silently.
		const origin = yield* originOf(packageRoot).pipe(soften);
		if (origin === undefined) {
			return {
				_tag: "Unresolved",
				reason: `whether ${packageRoot} is a checkout of its own repo could not be read`,
			};
		}
		return {_tag: "Entrypoint", entrypoint: entrypointFor(path, origin, binPath)};
	});
