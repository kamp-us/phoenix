/**
 * `guard pointer-guard check` — every backticked repo path in a tracked `CLAUDE.md` resolves
 * (#988), ported off `pipeline-cli pointer-guard check` (epic #5720).
 *
 * Scope is the git-tracked `CLAUDE.md` set: `node_modules` docs and untracked scratch files are out,
 * and a renamed target reds the moment a referencing CLAUDE.md is committed. `.decisions/` and
 * `.patterns/` are deliberately not scanned — the first is the history surface, where an ADR
 * legitimately names code that has since moved, and the second cites external dependency trees that
 * resolution alone cannot tell from a deleted in-repo path.
 *
 * **`git ls-files` is proven before any `check-ignore` runs.** A failed subprocess reads as "not
 * ignored" at that seam, so a `git` that cannot run at all would turn every pointer stale and
 * report a tree-wide violation. Listing first means a broken `git` lands on UNKNOWN instead.
 */

import {Effect, type FileSystem, Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {discoverRepoRoot} from "../delegate/root.ts";
import {execCapture} from "../io/exec.ts";
import {exists, type ReadFailed, readFile} from "../io/fs.ts";
import type {VerbOutcome} from "../verb.ts";
import {atLine} from "./annotate.ts";
import {extractPathRefs, type StalePointer, stalePointersIn, staleReport} from "./pointer.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard pointer-guard check";

const DOC = "CLAUDE.md";

/** Everything this verb needs: the filesystem for reads and probes, the spawner for git. */
type Scan<A, E = ReadFailed> = Effect.Effect<
	A,
	E,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
>;

/**
 * The tracked `CLAUDE.md` files under `root`, or `null` when git could not answer.
 *
 * NUL-delimited so a path with a space survives; the two pathspecs cover the root file and every
 * nested one, so a consuming repo with per-app CLAUDE.md files is checked too.
 */
const trackedDocs = (root: string): Scan<ReadonlyArray<string> | null, never> =>
	Effect.gen(function* () {
		const result = yield* execCapture("git", ["-C", root, "ls-files", "-z", DOC, `*/${DOC}`]);
		return result.ok ? result.stdout.split("\0").filter((file) => file !== "") : null;
	});

/**
 * Whether `path` is gitignored under `root`.
 *
 * `check-ignore -q` exits 0 on a match and 1 on no match, so only a clean run is a match. A
 * gitignored pointer names a deliberately-absent generated path, which counts as resolved.
 */
const isIgnored = (root: string, path: string): Scan<boolean, never> =>
	Effect.map(
		execCapture("git", ["-C", root, "check-ignore", "-q", "--", path]),
		(result) => result.ok,
	);

const judge = (root: string): Scan<GuardVerdict> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const files = yield* trackedDocs(root);
		if (files === null) {
			return unknown(
				`${VERB}: could not list the tracked ${DOC} files under ${root} — git did not answer, so the verdict is UNKNOWN, never clean.`,
			);
		}
		if (files.length === 0) {
			return zeroScope(
				`${VERB}: scanned ZERO git-tracked ${DOC} files — fail-closed (ADR 0092). Is the repo root correct?`,
			);
		}
		const stale: Array<StalePointer> = [];
		// One answer per path per file: the resolution is what costs a probe and a subprocess, and a
		// doc names the same path several times.
		for (const file of files) {
			const text = yield* readFile(path.join(root, file));
			const resolved = new Map<string, boolean>();
			for (const ref of extractPathRefs(text)) {
				if (resolved.has(ref.path)) continue;
				const onDisk = yield* exists(path.join(root, ref.path));
				resolved.set(ref.path, onDisk || (yield* isIgnored(root, ref.path)));
			}
			stale.push(...stalePointersIn(file, text, (p) => resolved.get(p) ?? false));
		}
		if (stale.length === 0) {
			return clean(
				`${VERB}: no stale ${DOC} pointers (${files.length} file(s) scanned)`,
				files.length,
			);
		}
		return violation(
			staleReport(VERB, stale),
			annotationsOrNone(() =>
				stale.map((s) =>
					atLine(
						"error",
						s.file,
						s.line,
						`\`${s.path}\` does not resolve on disk — a backticked repo pointer that rots sends every reader to a path that is not there (#988). Fix: point at its current location, or restore the file.`,
					),
				),
			),
		);
	});

export interface PointerGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runPointerGuard = (
	options: PointerGuardOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
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
