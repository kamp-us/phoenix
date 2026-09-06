/**
 * `AgentSdk` — the four Agent SDK entry points this layer uses, behind one seam.
 *
 * The default is the real SDK. A test hands in a scripted `Query` instead, which is the only way to
 * drive `start`, the permission callback and the event fold without a Claude Code subprocess and
 * live credentials.
 *
 * `version` is the seam's third member because the SDK exports no version constant and its
 * `package.json` is not in its `exports` map (`@anthropic-ai/claude-agent-sdk@0.3.259`), so nothing
 * can import it. It is written once here and pinned against the catalog in `version.unit.test.ts`.
 */

import type {
	GetSessionMessagesOptions,
	ListSessionsOptions,
	ModelInfo,
	Options,
	PermissionMode,
	SDKMessage,
	SDKSessionInfo,
	SDKUserMessage,
	SessionMessage,
	SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import {getSessionMessages, listSessions, query} from "@anthropic-ai/claude-agent-sdk";

/** The `pnpm-workspace.yaml` catalog pin of `@anthropic-ai/claude-agent-sdk`. */
export const SDK_VERSION = "0.3.259";

/**
 * The `Query` members this layer actually calls.
 *
 * Narrower than the SDK's own `Query`, which declares two dozen control requests: a scripted
 * stand-in has to implement what the layer calls, not everything the CLI can be asked. The real
 * `Query` satisfies this structurally, so the seam's default needs no adapter. The return types are
 * `unknown` where the layer reads nothing off the answer, which keeps a stand-in from having to
 * mint an SDK payload it never uses.
 *
 * `initializationResult` is the layer's opened-ness signal. `sdk.d.ts` at the `0.3.259` pin
 * documents it as returning "the cached first-connect result" (the contrast `Query.reinitialize`
 * draws against itself), so the `initialize` control request it settles completes on connect with
 * no prompt sent. The `system`/`init` message is the other thing and cannot serve: the same file
 * calls it "session metadata the CLI emits at the start of each turn", and there is no turn before
 * a prompt.
 */
export interface AgentSession extends AsyncGenerator<SDKMessage, void> {
	initializationResult(): Promise<unknown>;
	interrupt(): Promise<unknown>;
	setPermissionMode(mode: PermissionMode): Promise<void>;
	/**
	 * The model switch, declared beside `setPermissionMode` and with the same precondition: the
	 * pin's `sdk.d.ts` says both are "only available in streaming input mode", which is the mode
	 * this layer's `AsyncIterable` prompt already puts every session in. It applies to subsequent
	 * responses on the live session — no respawn (#7981).
	 */
	setModel(model?: string): Promise<void>;
	supportedModels(): Promise<ReadonlyArray<ModelInfo>>;
	/**
	 * The session's slash commands, declared beside `supportedModels` and read the same way — once
	 * per open. The pin's `sdk.d.ts` documents it as tracking the latest `commands_changed` push, so
	 * a re-fetch and that push answer the same list and either one is a whole catalog (#8060).
	 */
	supportedCommands(): Promise<ReadonlyArray<SlashCommand>>;
	close(): void;
}

export interface AgentSdk {
	readonly query: (params: {
		readonly prompt: AsyncIterable<SDKUserMessage>;
		readonly options: Options;
	}) => AgentSession;
	readonly getSessionMessages: (
		sessionId: string,
		options: GetSessionMessagesOptions,
	) => Promise<ReadonlyArray<SessionMessage>>;
	/**
	 * Every session the CLI's on-disk store holds — the whole machine's, since `dir` omitted is
	 * "sessions across all projects" (`sdk.d.ts`, `listSessions`).
	 *
	 * The layer calls it with no options at all, which leaves `includeProgrammatic` at its `true`
	 * default. The pin documents `false` as what "IDE session pickers pass for parity with terminal
	 * `/resume`", and epic #8070's ruling 3 is the opposite of that parity — one unified list where
	 * every session on the machine appears whatever started it — so the default is the ruled
	 * behaviour. `sessions.unit.test.ts` pins that nothing is passed.
	 */
	readonly listSessions: (options?: ListSessionsOptions) => Promise<ReadonlyArray<SDKSessionInfo>>;
	readonly version: string;
}

export const realAgentSdk: AgentSdk = {
	query: (params) => query(params),
	getSessionMessages: (sessionId, options) => getSessionMessages(sessionId, options),
	listSessions: (options) => listSessions(options),
	version: SDK_VERSION,
};
