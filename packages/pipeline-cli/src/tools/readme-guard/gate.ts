/**
 * The `readme-guard` filesystem gate — the IO seam behind #938/#939's "every
 * packages/* workspace member carries a README.md" check, split from `command.ts`
 * so it is crossable in unit tests over a fake repo dir rather than only by
 * spawning the bin (the core-in-its-own-file idiom; #855).
 *
 * `checkReadmes` is the CI gate: it grounds its scope in `pnpm-workspace.yaml`
 * (asserting `packages/*` is a declared member glob), enumerates the immediate
 * subdirectories of `packages/`, gathers `package.json`/`README.md` presence for
 * each, and delegates the verdict to the pure core (`readme-guard.ts`). It fails
 * `CheckFailed` (exit non-zero) when a real member lacks a README OR when zero
 * members are in scope (fail-closed, ADR 0092). A directory/file IO failure is an
 * `IoError` (also non-zero — both failures, undistinguished, per the bin's contract).
 */
import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {Console, Data, Effect} from "effect";
import {
	judge,
	type PackageDirCandidate,
	parseWorkspacePackageGlobs,
	renderReport,
} from "./readme-guard.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{readonly reason: string}> {}

/** The workspace glob that scopes this guard — the convention is about `packages/*` specifically. */
const PACKAGES_GLOB = "packages/*";
const PACKAGES_DIR = "packages";

/**
 * Enumerate the immediate subdirectories of `<root>/packages` into the pure core's
 * candidate shape — each carrying whether it holds a `package.json` (⇒ a real
 * workspace member, not a dead shell) and a `README.md`.
 */
const enumeratePackageCandidates = (
	root: string,
): Effect.Effect<ReadonlyArray<PackageDirCandidate>, IoError> =>
	Effect.try({
		try: () => {
			const base = join(root, PACKAGES_DIR);
			const entries = readdirSync(base, {withFileTypes: true});
			const candidates: Array<PackageDirCandidate> = [];
			for (const entry of entries) {
				// A symlink to a dir still resolves through statSync; skip plain files.
				const abs = join(base, entry.name);
				if (!statSync(abs).isDirectory()) continue;
				candidates.push({
					dir: `${PACKAGES_DIR}/${entry.name}`,
					hasPackageJson: existsSync(join(abs, "package.json")),
					hasReadme: existsSync(join(abs, "README.md")),
				});
			}
			return candidates;
		},
		catch: (cause) => new IoError({path: join(root, PACKAGES_DIR), cause}),
	});

/** Read `pnpm-workspace.yaml` and assert `packages/*` is a declared member glob. */
const assertPackagesGlobDeclared = (root: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const workspacePath = join(root, "pnpm-workspace.yaml");
		const text = yield* Effect.try({
			try: () => readFileSync(workspacePath, "utf8"),
			catch: (cause) => new IoError({path: workspacePath, cause}),
		});
		const globs = parseWorkspacePackageGlobs(text);
		if (!globs.includes(PACKAGES_GLOB)) {
			// The workspace no longer declares packages/* — the guard's scope assumption
			// is broken, so fail closed rather than scan a phantom directory.
			return yield* Effect.fail(
				new CheckFailed({
					reason: `readme-guard: pnpm-workspace.yaml does not declare the \`${PACKAGES_GLOB}\` member glob (found: ${globs.join(", ") || "<none>"}) — the guard's scope assumption is broken, fail-closed (ADR 0092).`,
				}),
			);
		}
	});

/**
 * The CI gate: succeed when every `packages/*` workspace member (a dir with a
 * `package.json`) carries a `README.md`, else `CheckFailed`. Fails closed on zero
 * members in scope (ADR 0092).
 */
export const checkReadmes = (root: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		yield* assertPackagesGlobDeclared(root);
		const candidates = yield* enumeratePackageCandidates(root);
		const verdict = judge(candidates);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
