/**
 * The names the Claude vertical proof, its config module and its local-only harness share.
 *
 * They live apart from `./desk.ts` because that module reads the proof's project root out of the
 * environment at import time, and a caller sets it only once its temp directory exists: a static
 * import of the config module from the test file would evaluate it first and throw. It is
 * `../../pi/proof/names.ts`'s split, for that file's reason.
 *
 * The replies are numbered by **position within one boot**, not by which prompt they answer. A boot
 * re-imports the config module and mints a fresh scripted layer (`src/config.ts` stamps a load
 * number on the URL), so a reply named after the prompt it answers would have hidden the one fact
 * the restart case turns on: which turn the resumed session replays.
 */

/** Where a caller's project root reaches a config module the loader imports with no arguments. */
export const PROJECT_ROOT_VAR = "CLAUDE_VERTICAL_PROOF_ROOT";

/**
 * The scripted child the delegation step spawns: the generic agent row under its own id, with a
 * scripted backend and no renderer. It is deliberately not `pi-session` — the kernel tools name a
 * program the registry knows and nothing more, so the step needs no second product to prove it.
 */
export const CHILD_PROGRAM = "ai-agent-session";

/** The permission request id the second turn raises, as the SDK spells a tool-use id. */
export const CARD = "toolu_01claudevertical";

export const PROMPT_1 = "read the readme";
export const PROMPT_2 = "now delete the build dir";
export const PROMPT_3 = "and summarise what you did";
export const PROMPT_4 = "try that again";

export const REPLY_1 = "the readme says this is a local app on the Tuval kernel";
export const REPLY_2 = "removed it";
/** The half-written reply the restart cuts. Its turn never reports `ready`. */
export const REPLY_3 = "I was in the middle of";
export const REPLY_4 = "done, and here is the summary";

/** The prompt and reply the delegation step round-trips through the child's own ports. */
export const CHILD_PROMPT = "what are you";
export const CHILD_REPLY = "a scripted agent session under the Claude process";
