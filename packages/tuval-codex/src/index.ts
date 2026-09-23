/**
 * The `codex-session` row a config registers, and what it takes to build one.
 *
 * The scope trio rides here because `codexSession` cannot be called without it: `scope` is two
 * branded ids (`@kampus/tuval-sdk/kernel/commands/spell`), and a config with no constructor for
 * them has a factory it cannot use.
 *
 * This entry reaches the codex app-server transport and never React; the window is `./window`'s,
 * so a browser bundle takes that door and nothing here.
 */

export {ClientId, type Scope, WorkspaceId} from "@kampus/tuval-sdk/kernel/commands/spell";
export {
	CODEX_MODES,
	CodexSessionConfig,
	type CodexSessionConfigInput,
	type CodexSessionSettings,
	codexSessionSettings,
} from "./config.ts";
export {
	CODEX_SESSION_PROGRAM,
	type CodexSessionProgram,
	type CodexSessionProgramOptions,
	codexSession,
} from "./program.ts";
export {CODEX_CHAT_WINDOW_REF} from "./renderer-ref.ts";
