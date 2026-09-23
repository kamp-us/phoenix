/**
 * The `pi-session` row a config registers, and what it takes to build one.
 *
 * The scope trio rides here because `piSessionProgram` cannot be called without it: `scope` is two
 * branded ids (`@kampus/tuval-sdk/kernel/commands/spell`), and a config with no constructor for
 * them has a factory it cannot use.
 *
 * This entry reaches Pi's model runtime and never React; the window is `./window`'s, so a browser
 * bundle takes that door and nothing here.
 */

export {ClientId, type Scope, WorkspaceId} from "@kampus/tuval-sdk/kernel/commands/spell";
export {
	PI_SESSION_PROGRAM,
	type PiSessionProgramOptions,
	piSessionProgram,
	projectRootOf,
} from "./program.ts";
export {PI_CHAT_WINDOW_REF} from "./renderer-ref.ts";
