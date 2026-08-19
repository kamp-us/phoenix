/**
 * `guard patch-guard check` — every maintained `pnpm patch` carries a registered behavior-pinning
 * test (ADR 0038's forcing function), ported off v1's `patch-guard check` (epic #5720).
 *
 * The verb is the IO boundary: read `patchedDependencies` out of `pnpm-workspace.yaml`, walk the
 * test tree gathering `@patch-pin:` markers, hand both to the pure rule in `./patch.ts`, seat the
 * answer on the group's exit taxonomy. v1 collapsed every red onto `1`; here an empty patch set
 * (`7`, ADR 0092), a failed read (`11`) and a real unpinned patch (`12`) are three numbers, because
 * their remedies are three different things.
 */

import {Effect, type FileSystem, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, isDirectory, type ReadFailed, readDir, readFile, realPath} from "../io/fs.ts";
import type {VerbOutcome} from "../verb.ts";
import {atFile} from "./annotate.ts";
import {
	auditPins,
	cleanSummary,
	missingPinFix,
	type PinMarker,
	parsePatchedDependencies,
	parsePinMarkers,
	pinViolationReport,
	stalePinFix,
} from "./patch.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard patch-guard check";

const WORKSPACE = "pnpm-workspace.yaml";

// Dirs never worth walking for test files: dependency trees, VCS, nested agent worktrees/checkouts
// (present only in a dev tree, never on a fresh CI checkout), and build output. Excluding `.claude`
// keeps the scan to THIS checkout's own test tree — a sibling worktree's markers are another
// checkout's business.
const IGNORE_DIRS = new Set([
	"node_modules",
	".git",
	".claude",
	"dist",
	"build",
	".turbo",
	".wrangler",
	"coverage",
]);

/** The behavior pin lives on a test — scope the marker scan to test files (any tier). */
const isTestFile = (name: string): boolean => /\.test\.(ts|tsx)$/.test(name);

export interface PatchGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Gather every `@patch-pin:` marker under `root`, depth-first, skipping {@link IGNORE_DIRS} at any
 * depth. Marker paths are repo-relative and POSIX-normalized, so a report is stable across
 * platforms and carries no absolute path.
 */
const gatherMarkers = (
	root: string,
	dir: string,
): Effect.Effect<ReadonlyArray<PinMarker>, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const found: Array<PinMarker> = [];
		// Resolved once per directory so the link test below compares like with like: an ancestor
		// that is itself a symlink (macOS `/tmp`) would otherwise make every child look linked.
		const realDir = yield* realPath(dir);
		for (const name of yield* readDir(dir)) {
			const abs = path.join(dir, name);
			if (yield* isDirectory(abs)) {
				if (IGNORE_DIRS.has(name)) continue;
				// A symlinked dir is NEVER recursed. Recursing one widens the pin scan — a guard failing
				// OPEN — and admits a symlink cycle, since IGNORE_DIRS screens by name, not link-ness.
				// v1 tested link-ness with `readLink`, which `io/fs.ts` does not expose; an entry whose
				// real path is not its own path is the same test. Symlinked FILES stay in scope, as at
				// base — hence the guard sits on this arm only.
				if ((yield* realPath(abs)) !== path.join(realDir, name)) continue;
				found.push(...(yield* gatherMarkers(root, abs)));
				continue;
			}
			if (!isTestFile(name)) continue;
			const relative = path.relative(root, abs).split(path.sep).join("/");
			found.push(...parsePinMarkers(yield* readFile(abs), relative));
		}
		return found;
	});

const judge = (
	root: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const target = path.join(root, WORKSPACE);
		if (!(yield* exists(target))) {
			return zeroScope(
				`${VERB}: ${root}/${WORKSPACE} does not exist — the guard found no maintained patch to check at all, fail-closed (ADR 0092). Is the repo root correct?`,
			);
		}
		const patched = parsePatchedDependencies(yield* readFile(target));
		if (patched.length === 0) {
			return zeroScope(
				`${VERB}: found ZERO patchedDependencies in ${WORKSPACE} — fail-closed (ADR 0092). Is the repo root correct, or did the workspace file move?`,
			);
		}
		const markers = yield* gatherMarkers(root, root);
		const audit = auditPins(patched, markers);
		const keys = patched.map((p) => p.key);
		if (audit.missing.length === 0 && audit.stale.length === 0) {
			return clean(cleanSummary(VERB, keys, markers.length), keys.length);
		}
		return violation(
			pinViolationReport(VERB, keys, audit),
			annotationsOrNone(() => [
				...audit.missing.map((dep) => atFile("error", WORKSPACE, missingPinFix(dep.key))),
				...audit.stale.map((marker) => atFile("error", marker.path, stalePinFix(marker))),
			]),
		);
	});

export const runPatchGuard = (
	options: PatchGuardOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const root =
			options.root ?? (yield* discoverRepoRoot(options.cwd).pipe(Effect.map((r) => r ?? null)));
		if (root === null) {
			return emitVerdict(
				unknown(
					`${VERB}: no repo root at or above ${options.cwd} — nothing to scope the scan to, so the verdict is UNKNOWN.`,
				),
				options.env,
			);
		}
		return emitVerdict(yield* judge(root), options.env);
	}).pipe(
		Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
			Effect.succeed(
				emitVerdict(
					unknown(
						`${VERB}: cannot read ${failure.path}: ${failure.reason} — the scan could not be completed, so the verdict is UNKNOWN, never clean.`,
					),
					options.env,
				),
			),
		),
	);
