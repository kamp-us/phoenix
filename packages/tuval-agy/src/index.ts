/**
 * The `agy-session` row a config registers, and what it takes to build one.
 *
 * This entry reaches the agy subprocess and never React; the window is `./window`'s, so a browser
 * bundle takes that door and nothing here.
 */

export {AGY_SESSION_PROGRAM, type AgySessionProgramOptions, agySessionProgram} from "./program.ts";
export {AGY_CHAT_WINDOW_REF} from "./renderer-ref.ts";
