/**
 * The names the Pi vertical proof, its config module and its browser harness share.
 *
 * They live apart from `./desk.ts` because that module reads the proof's project root out of the
 * environment at import time, and a caller sets it only once its temp directory exists: a static
 * import of the config module from the test file would evaluate it first and throw.
 *
 * The replies are numbered by **position within one boot**, not by which prompt they answer. A boot
 * re-imports the config module and mints a fresh faux provider (`src/config.ts` stamps a load
 * number on the URL), so the first turn after a restart is answered by `REPLY_1` again — which is
 * itself a fact the restart proof asserts, and a reply named after its prompt would have hidden it.
 */

/** Where a caller's project root reaches a config module the loader imports with no arguments. */
export const PROJECT_ROOT_VAR = "PI_VERTICAL_PROOF_ROOT";

export const PROMPT_1 = "what is this project";
export const PROMPT_2 = "and what runs the chat";
export const PROMPT_3 = "still there after the restart";
export const PROMPT_4 = "and after a dropped socket";

export const REPLY_1 = "a local app on the Tuval kernel";
export const REPLY_2 = "one Pi session behind the agent ports";
export const REPLY_3 = "the third answer of this boot";
export const REPLY_4 = "the fourth answer of this boot";
