/**
 * The read-only IO boundary for the tripwire bin — plain node, no Effect import.
 *
 * Kept separate from `bin.ts` on purpose: these are best-effort, must-never-throw guards over `git`
 * plumbing and a log append (the read-only contract — recording must never perturb the commit it
 * observes), so native `try/catch`-and-swallow is the correct shape, not domain failure modeled in an
 * Effect `E` channel. Isolating them here keeps `bin.ts` free of raw `try/catch` (the effect-file ban).
 */
import {execFileSync} from "node:child_process";
import {appendFileSync} from "node:fs";
import {resolve} from "node:path";

/** Run a read-only `git` command; on any failure (git absent, not a repo) return "" rather than throw. */
export const gitFact = (args: readonly string[]): string => {
	try {
		return execFileSync("git", args as string[], {encoding: "utf8"}).trim();
	} catch {
		return "";
	}
};

/** `git-dir == git-common-dir` ⇒ the primary checkout; they differ in a linked worktree. */
export const detectPrimaryCheckout = (): boolean => {
	const gitDir = gitFact(["rev-parse", "--absolute-git-dir"]);
	const commonRaw = gitFact(["rev-parse", "--git-common-dir"]);
	if (gitDir === "" || commonRaw === "") return false; // unknowable ⇒ don't over-claim primary
	const common = commonRaw.startsWith("/") ? commonRaw : resolve(process.cwd(), commonRaw);
	return resolve(gitDir) === resolve(common);
};

/** Read the staged deletions as `git diff --cached --name-status` output (read-only). */
export const stagedDeletions = (): string =>
	gitFact(["diff", "--cached", "--name-status", "--diff-filter=D"]);

/** Append one record line to the log; a missing/unwritable path is swallowed (best-effort attribution). */
export const appendRecord = (logPath: string, line: string): void => {
	try {
		appendFileSync(logPath, line);
	} catch {
		// unwritable log path must never perturb the commit — read-only contract; the caller still warns.
	}
};

/** The attribution log path: `$PRIMARY_INDEX_TRIPWIRE_LOG`, else a temp file. */
export const defaultLogPath = (): string =>
	process.env.PRIMARY_INDEX_TRIPWIRE_LOG ??
	resolve(process.env.TMPDIR ?? "/tmp", "primary-index-tripwire.jsonl");
