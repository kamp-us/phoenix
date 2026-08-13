/**
 * What Claude Code does with a hook's exit code, as a constant fabrika's own codes are checked
 * against.
 *
 * Read first-party out of the installed build rather than from docs or intuition — `strings` on the
 * 2.1.228 binary, under its *Before tool execution* section:
 *
 * ```
 * Exit code 0 - stdout/stderr not shown
 * Exit code 2 - show stderr to model and block tool call
 * Other exit codes - show stderr to user only but continue with tool call
 * ```
 *
 * and, under *When a new session is started*:
 *
 * ```
 * Exit code 2 - show stderr to user only
 * ```
 *
 * So the blocking power is `PreToolUse`-specific and single-coded: on `PreToolUse` exactly one exit
 * code stops the tool call, and every other non-zero code shows stderr and lets it proceed. On
 * `SessionStart` the same `2` is user-visible only and blocks nothing. Triage confirmed both legs
 * live on 2.1.227 — a probe hook on matcher `Task|Workflow` exiting `2` stopped an agent spawn, the
 * identical probe exiting `3` did not (#5423).
 *
 * The consequence fabrika cares about is a *polarity*, not a style rule: a bootstrap or dispatch
 * failure is a state in which no verb ran and no evidence exists, which ADR 0250 rules must fail
 * **open**. Seating any such state on this code makes it deny instead.
 */

/** The one `PreToolUse` exit code that blocks the tool call. No fabrika exit code may be this. */
export const PRETOOLUSE_BLOCKING_EXIT = 2;

/** The harness build the constant above was read out of, cited where the check reports it. */
export const HARNESS_BUILD_READ = "2.1.228";
