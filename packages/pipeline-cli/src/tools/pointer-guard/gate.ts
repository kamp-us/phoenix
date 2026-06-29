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
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {Console, Data, Effect} from "effect";
import {findStalePointersIn, renderReport, type StalePointer} from "./pointer-guard.ts";

/** A directory/file/git IO failure: the run couldn't complete. */
export class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{readonly reason: string}> {}

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
	try {
		execFileSync("git", ["-C", root, "check-ignore", "-q", "--", path], {stdio: "ignore"});
		return true;
	} catch {
		return false;
	}
};

/** Scan every git-tracked `CLAUDE.md` under `root` and collect the stale pointers. */
export const scanStalePointers = (
	root: string,
): Effect.Effect<ReadonlyArray<StalePointer>, IoError> =>
	Effect.gen(function* () {
		const files = yield* listClaudeMdFiles(root);
		const exists = (path: string): boolean =>
			existsSync(join(root, path)) || isGitIgnored(root, path);
		const stale: StalePointer[] = [];
		for (const file of files) {
			const text = yield* Effect.try({
				try: () => readFileSync(join(root, file), "utf8"),
				catch: (cause) => new IoError({path: file, cause}),
			});
			stale.push(...findStalePointersIn(file, text, exists));
		}
		return stale;
	});

/**
 * The CI gate: succeed when no git-tracked CLAUDE.md has a stale backticked pointer,
 * else `CheckFailed` with the per-pointer report. Fails closed on zero CLAUDE.md in
 * scope (ADR 0092) — never a vacuous green on a mis-rooted scan.
 */
export const checkPointers = (root: string): Effect.Effect<void, IoError | CheckFailed> =>
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
