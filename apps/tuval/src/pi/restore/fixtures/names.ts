/**
 * The names the Pi restore proof and its config module share.
 *
 * They live apart from `pi-desk.ts` because that module reads the proof's project root out of the
 * environment at import time, and the proof sets it only once its temp directory exists: a static
 * import of the config module from the test file would evaluate it first and throw.
 */

export const AGENT_NODE = "agent";
export const WINDOW_NODE = "window";

/** Where the proof's temp project root reaches a config module the loader imports with no arguments. */
export const PROJECT_ROOT_VAR = "PI_RESTORE_PROOF_ROOT";

/** What the assistant says before reaching for a tool: the item the proof stops the app just after. */
export const BEFORE_THE_TOOL = "thinking about it";
