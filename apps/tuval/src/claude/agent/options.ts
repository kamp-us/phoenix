/**
 * The row's config as plain data, and the `Options` object one `query()` is opened with.
 *
 * Kept out of the layer so the whole of what reaches the SDK is assertable without a subprocess:
 * `queryOptionsOf` is a pure function of the config, the tool server and the environment.
 *
 * `pathToClaudeCodeExecutable` is deliberately never set. The CLI the SDK spawns is the `claude` on
 * `PATH`, and SDK/CLI drift is accepted for this slice (founder ruling on #7580) — the `start` log
 * line names both versions so a drifted pair is visible in the transcript rather than silent.
 */

import {userInfo} from "node:os";
import type {McpServerConfig, Options, PermissionMode} from "@anthropic-ai/claude-agent-sdk";
import type {Mode} from "../../ai-agent/ports/index.ts";
import {TUVAL_SERVER_NAME, type TuvalToolServer} from "../tools/index.ts";
import type {AgentSdk} from "./sdk.ts";
import type {SpawnClaudeCodeProcess} from "./subprocess.ts";

/**
 * The modes a row may offer. `bypassPermissions` and `dontAsk` are not among them and never are:
 * both hand the model a decision the operator is here to make, and this program's whole permission
 * surface is the card. A row naming either is refused the same way it is refused a typo.
 */
export const OFFERABLE_MODES: ReadonlyArray<string> = ["default", "acceptEdits", "plan", "auto"];

export interface ClaudeAiAgentOptions {
	/** The mode a session opens on. A mode outside `modes` opens the session on `default`. */
	readonly permissionMode: Mode;
	/** The modes this row advertises. Anything outside `OFFERABLE_MODES` is dropped. */
	readonly modes: ReadonlyArray<Mode>;
	/**
	 * Tools auto-allowed without a card, on top of the kernel tools this layer always allows. Wire
	 * names only — a bare built-in name here would hand the model a tool with no card and no rule.
	 */
	readonly allowedTools: ReadonlyArray<string>;
	readonly model?: string;
	/** The SDK seam. Absent is the real SDK; a test hands in a scripted `Query`. */
	readonly sdk?: AgentSdk;
	/** Absent leaves the SDK's own local spawn, which is what runs the `claude` on `PATH`. */
	readonly spawn?: SpawnClaudeCodeProcess;
	/**
	 * The id a fresh session opens under. Absent mints a v4 UUID, which is what a run does; a test
	 * pins it so the scripted `init` frame and the id the layer opened on name one session.
	 */
	readonly newSessionId?: () => string;
}

/** The modes this row actually offers, in the order it named them, minus the two never offered. */
export const advertisedModes = (options: ClaudeAiAgentOptions): ReadonlyArray<Mode> =>
	options.modes.filter((mode) => OFFERABLE_MODES.includes(mode));

/**
 * The mode a session opens on: the mode the layer is holding when it holds one, else the row's, else
 * `default`. Either way it is filtered through what the row advertises.
 *
 * `held` is what makes the announced mode and the session's real mode the same fact. The layer emits
 * its held mode on every `start`, and a `setMode` before the first session — or before a reconnect —
 * is permitted, so a session opened on the row's static mode would be running one mode while the
 * stream said another.
 */
export const openingMode = (
	options: ClaudeAiAgentOptions,
	held: Mode | null = null,
): PermissionMode => {
	const offered = advertisedModes(options);
	if (held !== null && offered.includes(held)) return held as PermissionMode;
	return offered.includes(options.permissionMode)
		? (options.permissionMode as PermissionMode)
		: "default";
};

/**
 * The environment the spawned CLI runs under.
 *
 * `USER` is the one variable this adds: on macOS the CLI reads it to find the keychain login, and a
 * process started without it (a launchd agent, some CI shells) leaves the spawned session unable to
 * authenticate (spike #7597, finding 4). `userInfo().username` is the fallback when the parent has
 * none.
 */
export const sessionEnv = (
	base: NodeJS.ProcessEnv = process.env,
	username: () => string = () => userInfo().username,
): Record<string, string | undefined> => ({
	...base,
	USER: base.USER === undefined || base.USER.length === 0 ? username() : base.USER,
});

/**
 * Which session one `query()` opens, as the one shape that cannot name both.
 *
 * The SDK refuses the pair: `sessionId` "cannot be used with `continue` or `resume` unless
 * `forkSession` is also set" (`sdk.d.ts`, `Options.sessionId`), and this layer never forks. A
 * `fresh` id goes to the CLI as its own `--session-id`, which is what gives the session an id
 * before the first turn; a `resume` id is the id the CLI already stored, and goes to `resume`.
 */
export type SessionChoice =
	| {readonly kind: "fresh"; readonly sessionId: string}
	| {readonly kind: "resume"; readonly sessionId: string};

export interface QueryOptionsInput {
	readonly cwd: string;
	readonly session: SessionChoice;
	readonly server: TuvalToolServer;
	readonly canUseTool: NonNullable<Options["canUseTool"]>;
	readonly env: Record<string, string | undefined>;
	readonly spawn?: SpawnClaudeCodeProcess | undefined;
	/** The mode the layer is holding, if an operator has set one. */
	readonly held?: Mode | null | undefined;
}

export const queryOptionsOf = (
	options: ClaudeAiAgentOptions,
	input: QueryOptionsInput,
): Options => {
	const servers: Record<string, McpServerConfig> = {[TUVAL_SERVER_NAME]: input.server.server};
	return {
		cwd: input.cwd,
		permissionMode: openingMode(options, input.held ?? null),
		allowedTools: [...new Set([...input.server.wireNames, ...options.allowedTools])],
		mcpServers: servers,
		canUseTool: input.canUseTool,
		env: input.env,
		...(input.session.kind === "fresh"
			? {sessionId: input.session.sessionId}
			: {resume: input.session.sessionId}),
		// `exactOptionalPropertyTypes` refuses an explicit `undefined` on an optional field, so an
		// absent option stays absent rather than being forwarded as one.
		...(options.model === undefined ? {} : {model: options.model}),
		...(input.spawn === undefined ? {} : {spawnClaudeCodeProcess: input.spawn}),
	};
};
