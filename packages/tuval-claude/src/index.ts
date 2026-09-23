/**
 * The `claude-session` row a config registers, and what it takes to build one.
 *
 * The scope trio rides here because `claudeSession` cannot be called without it: `scope` is two
 * branded ids (`@kampus/tuval-sdk/kernel/commands/spell`), and a config with no constructor for
 * them has a factory it cannot use.
 *
 * This entry reaches the Agent SDK and never React; the window is `./window`'s, so a browser
 * bundle takes that door and nothing here.
 */

export {ClientId, type Scope, WorkspaceId} from "@kampus/tuval-sdk/kernel/commands/spell";
export {
	CLAUDE_MODES,
	type ClaudePermissionMode,
	ClaudeSessionConfig,
	type ClaudeSessionConfigInput,
	type ClaudeSessionSettings,
	claudeSessionSettings,
	DEFAULT_ALLOWED_TOOLS,
	TUVAL_WIRE_PREFIX,
} from "./config.ts";
export {
	CLAUDE_SESSION_CAPABILITIES,
	CLAUDE_SESSION_PROGRAM,
	type ClaudeSessionProgram,
	type ClaudeSessionProgramOptions,
	claudeSession,
	claudeSessionLayer,
	configChanged,
} from "./program.ts";
export {CLAUDE_CHAT_WINDOW_REF} from "./renderer-ref.ts";
