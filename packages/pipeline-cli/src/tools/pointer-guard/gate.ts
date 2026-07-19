/**
 * The `pointer-guard` filesystem gate — the IO seam behind #988's stale-pointer
 * scan, split out of `command.ts` so it is crossable in unit tests over a fake repo
 * dir rather than only by spawning the bin (the core-in-its-own-file idiom; #855).
 * `command.ts` wires this effect to the Effect CLI and maps `CheckFailed` to the
 * non-zero gate exit; the exit-code contract lives there.
 *
 * `checkPointers` is the CI gate: it lists the repo's git-tracked `CLAUDE.md` files,
 * parses each for backticked repo-root-relative path pointers (`pointer-guard.ts`),
 * and fails `CheckFailed` (exit non-zero) if any pointer does not resolve on disk.
 * Git-tracked is the right boundary — `node_modules` docs and untracked scratch
 * files are out, and a renamed/deleted target reds the gate the moment a referencing
 * CLAUDE.md is committed. References resolve **repo-root-relative**, because the
 * path-likeness filter only admits tokens that begin with a known repo top-level
 * segment (`apps/`, `packages/`, …) — those are root-anchored by construction.
 *
 * A pointer resolves when it **exists OR is gitignored**. The gitignored case is
 * load-bearing: CLAUDE.md legitimately points at a deliberately-absent generated /
 * runtime path the doc tells you to create — `apps/web/.env` ("cp .env.example
 * .env"), gitignored and so absent in a fresh CI checkout though present in a dev
 * tree. That is a valid pointer, not rot, so a gitignored path counts as resolved;
 * a renamed source file (neither present nor ignored) is what stays flagged.
 *
 * Fail-closed on zero scope (ADR 0092): a scan that finds no CLAUDE.md is a
 * misconfiguration (wrong root), not a vacuous pass. A directory/file IO failure is
 * an `IoError` (also non-zero — both failures, undistinguished, per the bin's contract).
 */
import {execFileSync} from "node:child_process";
import {Console, Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {
	extractPathRefs,
	findStalePointersIn,
	renderReport,
	type StalePointer,
} from "./pointer-guard.ts";

/** A directory/file/git IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

/**
 * List the repo's git-tracked `CLAUDE.md` files at any depth (NUL-delimited, so
 * paths with spaces survive). The pathspecs cover the root file and every nested
 * `*​/CLAUDE.md` — a consuming repo with per-app CLAUDE.md files is checked too.
 */
export const listClaudeMdFiles = (root: string): Effect.Effect<ReadonlyArray<string>, IoError> =>
	Effect.try({
		try: () =>
			execFileSync("git", ["-C", root, "ls-files", "-z", "CLAUDE.md", "*/CLAUDE.md"], {
				encoding: "utf8",
			})
				.split("\0")
				.filter((f) => f !== ""),
		catch: (cause) => new IoError({path: root, cause}),
	});

/**
 * Is `path` gitignored under `root`? `git check-ignore -q` exits 0 on a match, 1 on
 * no match (which `execFileSync` throws on), 128 on error — only a clean exit 0 is a
 * match, every throw is "not ignored". A gitignored pointer names a deliberately-absent
 * generated/runtime path (`apps/web/.env`), so it counts as resolved, not as rot.
 */
const isGitIgnored = (root: string, path: string): boolean => {
	// biome-ignore lint/plugin: best-effort probe — check-ignore throws on no-match (exit 1) or error (128), both absorbed into false ("not ignored"), never the E channel; a total predicate, not Effect-cosplay.
	try {
		execFileSync("git", ["-C", root, "check-ignore", "-q", "--", path], {stdio: "ignore"});
		return true;
	} catch {
		return false;
	}
};

/**
 * Scan every git-tracked `CLAUDE.md` under `root` and collect the stale pointers.
 *
 * File reads + on-disk probes route through the Effect `FileSystem`/`Path` seam (over
 * the bin's `NodeServices.layer`), so a gate `unit` test scripts an in-memory repo
 * instead of touching real disk (.patterns/effect-platform-access.md); a read fault
 * folds `PlatformError` → `IoError`. The pure scanner (`findStalePointersIn`) filters
 * by a *synchronous* `exists` predicate, which the async fs seam can't be inline — so
 * existence is precomputed per referenced path here and fed to the scanner as a lookup.
 * A pointer resolves when it exists OR is gitignored (a deliberately-absent
 * generated/runtime path like `apps/web/.env`); git IO stays a raw subprocess (the
 * subprocess seam is a separate migration — `.patterns/effect-process-cli-shell.md`).
 */
export const scanStalePointers = (
	root: string,
): Effect.Effect<ReadonlyArray<StalePointer>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const files = yield* listClaudeMdFiles(root);
		const stale: StalePointer[] = [];
		for (const file of files) {
			const text = yield* fs
				.readFileString(path.join(root, file), "utf8")
				.pipe(Effect.mapError((cause) => new IoError({path: file, cause})));
			const resolved = new Map<string, boolean>();
			for (const ref of extractPathRefs(text)) {
				if (resolved.has(ref.path)) continue;
				const onDisk = yield* fs
					.exists(path.join(root, ref.path))
					.pipe(Effect.orElseSucceed(() => false));
				resolved.set(ref.path, onDisk || isGitIgnored(root, ref.path));
			}
			stale.push(...findStalePointersIn(file, text, (p) => resolved.get(p) ?? false));
		}
		return stale;
	});

/**
 * The CI gate: succeed when no git-tracked CLAUDE.md has a stale backticked pointer,
 * else `CheckFailed` with the per-pointer report. Fails closed on zero CLAUDE.md in
 * scope (ADR 0092) — never a vacuous green on a mis-rooted scan.
 */
export const checkPointers = (
	root: string,
): Effect.Effect<void, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const files = yield* listClaudeMdFiles(root);
		if (files.length === 0) {
			return yield* Effect.fail(
				new CheckFailed({
					reason:
						"pointer-guard: scanned ZERO git-tracked CLAUDE.md files — fail-closed (ADR 0092). " +
						"Is the repo root correct?",
				}),
			);
		}
		const stale = yield* scanStalePointers(root);
		if (stale.length === 0) {
			yield* Console.log(`pointer-guard: no stale CLAUDE.md pointers (${files.length} scanned)`);
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(stale)}));
	});
