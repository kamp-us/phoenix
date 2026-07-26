/**
 * The exit-code rule that outranks any per-tool choice: **a verdict a tool PROVED must never share
 * an exit code with a failure to invoke** (#4208, #4219).
 *
 * `1` is what effect-cli returns for a usage error (a bad flag, a typo'd subcommand) and what the
 * runner returns when a module fails to load; `127` is the shell's missing-binary code. A
 * proven-ordinary verdict seated on either is unreadable as proof — `[ $? -ne 0 ]` then reads "the
 * tool never ran" as "the tool ran and proved it ordinary", the fail-open direction every §CP guard
 * exists to close. `STDIN_READ_FAILED_EXIT_CODE = 4` (`read-stdin.ts`) is this same rule on the
 * input side; this is its verdict side, shared so the §CP classifier verbs cannot drift apart.
 */
export const PROVEN_ORDINARY_EXIT_CODE = 3;
