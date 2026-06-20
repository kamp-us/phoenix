/**
 * The `check` IO gate — the filesystem seam behind #638's repo-wide dead-link
 * scan, split out of `bin.ts` so it is crossable in unit tests over a fake repo
 * dir rather than only by spawning the bin (the core-in-its-own-file idiom; #855).
 * `bin.ts` wires this effect to the Effect CLI and maps `CheckFailed` to the
 * non-zero gate exit; the exit-code contract lives there.
 *
 * `checkLinks` is the CI gate: it lists the repo's git-tracked `.md` files, parses
 * each for internal links (`doc-links.ts`), and fails `CheckFailed` (exit non-zero)
 * if any target does not resolve on disk. Git-tracked is the right boundary —
 * `node_modules` docs and untracked scratch files are out, and a renamed/deleted
 * target reds the gate the moment a referencing doc is committed. A directory/file
 * IO failure is an `IoError` (also non-zero — both failures, undistinguished, per
 * the bin's contract).
 */
import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {isAbsolute, join, resolve} from "node:path";
import {Console, Data, Effect} from "effect";
import {type DeadLink, findDeadLinksIn, renderReport} from "./doc-links.ts";

/** A directory/file/git IO failure: the run couldn't complete. */
export class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{readonly reason: string}> {}

/** List the repo's git-tracked `*.md` files (NUL-delimited, so paths with spaces survive). */
export const listMarkdownFiles = (root: string): Effect.Effect<ReadonlyArray<string>, IoError> =>
	Effect.try({
		try: () =>
			execFileSync("git", ["-C", root, "ls-files", "-z", "*.md"], {encoding: "utf8"})
				.split("\0")
				.filter((f) => f !== ""),
		catch: (cause) => new IoError({path: root, cause}),
	});

/**
 * Resolve a doc's link target against disk. An absolute target (`/foo`) is rooted
 * at the repo root (the doc-author convention for a "repo-absolute" link); a
 * relative target is resolved against the linking file's directory.
 */
const targetExists =
	(root: string) =>
	(file: string, target: string): boolean => {
		const fileDir = resolve(root, file, "..");
		const abs = isAbsolute(target) ? join(root, target) : resolve(fileDir, target);
		return existsSync(abs);
	};

/** Scan every git-tracked `.md` under `root` and collect the dead internal links. */
export const scanDeadLinks = (root: string): Effect.Effect<ReadonlyArray<DeadLink>, IoError> =>
	Effect.gen(function* () {
		const files = yield* listMarkdownFiles(root);
		const exists = targetExists(root);
		const dead: DeadLink[] = [];
		for (const file of files) {
			const text = yield* Effect.try({
				try: () => readFileSync(join(root, file), "utf8"),
				catch: (cause) => new IoError({path: file, cause}),
			});
			dead.push(...findDeadLinksIn(file, text, exists));
		}
		return dead;
	});

/**
 * The CI gate: succeed when no git-tracked doc has a dead internal link, else
 * `CheckFailed` with the per-link report.
 */
export const checkLinks = (root: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const dead = yield* scanDeadLinks(root);
		if (dead.length === 0) {
			yield* Console.log("doc-links: no dead internal doc links");
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(dead)}));
	});
