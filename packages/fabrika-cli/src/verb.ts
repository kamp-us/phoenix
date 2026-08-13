/**
 * What every fabrika verb returns, and the exit codes it may seat an answer on.
 *
 * A verb is a **pure function of its dependencies** — it computes an outcome, it does not write
 * streams or exit. The CLI adapter does both. That split is what makes a verb's refusals as
 * deterministically testable as its answers: a test asserts the exit code and the bytes on each
 * channel without spawning a process.
 *
 * The reserved codes are the interface convention's, not a per-verb choice:
 *
 * | Code  | Reserved for                                          |
 * |-------|-------------------------------------------------------|
 * | `0`   | the answer was produced on stdout                     |
 * | `1`   | usage error, or the verb failed to run                |
 * | `2`   | **never allocated** — the harness's block code        |
 * | `126` | no implementation could be resolved                   |
 * | `127` | the verb never ran at all (unresolved binary)         |
 * | `3`+  | the verb's own proven outcomes                        |
 *
 * A verdict a verb PROVED must never share an exit code with a failure to invoke (#4208, #4219):
 * `1` is what the Effect CLI returns for a bad flag and what a failed module load returns, so a
 * proven refusal seated there is unreadable as proof — `[ $? -ne 0 ]` would read "never ran" as
 * "ran and proved it".
 */

/** The answer is on stdout. */
export const ANSWER = 0;
/** Usage error, or the verb failed to run. */
export const FAILED = 1;

/**
 * `fabrika` started and could not reach a working set of verbs — an unlinked dependency, a
 * repo-local install it could not execute, a cwd it refuses to answer from.
 *
 * **Seated at `126` because `2` blocks a tool call, and this state may never block one.** A
 * `PreToolUse` hook's exit `2` is the harness's *one* code for "block the tool call"
 * (`hook/harness-exit.ts`), so while this state sat there a fabrika that could not bootstrap
 * blocked every `Task`/`Workflow` spawn in the session — the exact inverse of ADR 0250's ruled
 * fail-open polarity for a hook whose verb never ran (#5423).
 *
 * `126` rather than the `3`+ band because this is not a verb's proven outcome and no group owns it:
 * every group's `3`+ band is already occupied by facts of its own (`3` is `EMPTY_STDIN` across the
 * aligned tables), and seating a bootstrap failure on one of those would collapse "I could not
 * start" into "I started and read nothing" — the collapse `hook/codes.ts` exists to prevent. `126`
 * is the shell's own *found but not executable*, the same claim one level up, and it sits beside
 * `127` so the two invocation failures read as one band.
 */
export const NO_IMPLEMENTATION = 126;

export interface VerbOutcome {
	readonly code: number;
	/** The answer channel. Empty unless `code` is 0 — a non-zero exit is UNKNOWN, never a partial answer. */
	readonly stdout: string;
	/** Diagnostics: the scope line, refusal reasons, progress. One entry per line. */
	readonly stderr: ReadonlyArray<string>;
}

/** An answer on stdout, with any diagnostics that explain how it was reached. */
export const answer = (stdout: string, stderr: ReadonlyArray<string> = []): VerbOutcome => ({
	code: ANSWER,
	stdout: stdout.endsWith("\n") || stdout === "" ? stdout : `${stdout}\n`,
	stderr,
});

/**
 * A refusal: a reason on stderr, a proven code, and **nothing on stdout**.
 *
 * The empty stdout is the load-bearing half. A verb that printed a partial or permissive answer
 * alongside a non-zero exit invites a caller to read the bytes without reading the status, which is
 * how an unreadable input comes to resolve to a plausible value instead of an error.
 */
export const refuse = (
	code: number,
	reason: string,
	extra: ReadonlyArray<string> = [],
): VerbOutcome => ({code, stdout: "", stderr: [...extra, reason]});
