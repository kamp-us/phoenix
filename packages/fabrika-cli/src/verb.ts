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
