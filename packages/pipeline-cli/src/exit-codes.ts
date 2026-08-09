/**
 * The exit-code rule that outranks any per-tool choice: **a verdict a tool PROVED must never share
 * an exit code with a failure to invoke** (#4208, #4219).
 *
 * `1` is what the runner returns when a module fails to load, and `127` is the shell's
 * missing-binary code. A proven-ordinary verdict seated on either is unreadable as proof —
 * `[ $? -ne 0 ]` then reads "the tool never ran" as "the tool ran and proved it ordinary", the
 * fail-open direction every §CP guard exists to close. `STDIN_READ_FAILED_EXIT_CODE = 4`
 * (`read-stdin.ts`) is this same rule on the input side; this is its verdict side, shared so the
 * §CP classifier verbs cannot drift apart.
 */
export const PROVEN_ORDINARY_EXIT_CODE = 3;

/**
 * A malformed invocation — an unrecognized flag, a missing flag value, a typo'd subcommand. The
 * router seats every effect-cli parse error here (`run.ts`) instead of leaving it on effect-cli's
 * default `1`, because `1` is a *verdict* for several verbs: `cp-cardinality decide` exits 1 for
 * `stop`, so `--pr`/`--head` (flags it never accepted) died on exit 1 and a caller transcribed
 * "the CLI refused my invocation" as "no approval at current head" — four approved §CP PRs recorded
 * as definite stops from a decision that never ran (#5072).
 *
 * Deliberately the same number as `STDIN_READ_FAILED_EXIT_CODE`: both mean "the tool never got
 * usable input, so it never decided". A caller's exit table wants ONE never-ran band, not a new
 * integer per way of failing to start.
 */
export const BAD_INVOCATION_EXIT_CODE = 4;
