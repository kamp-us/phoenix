/**
 * `aiAgentProgram` — the row factory both AI agent programs call.
 *
 * One generic core, one generic handler set, one set of ports; the only thing a caller varies is
 * the layer under it and the identity on it (founder ruling, 2026-09-02). A row with no renderer
 * is headless and runs exactly the same (founder ruling on #7557), because rendering is a
 * reference the kernel stores and nothing here reads.
 *
 * `capabilities` is empty. The #7467 records are inert data the kernel enforces nothing on
 * (`registry/program.ts`), so asking for a capability here would say something false about what
 * runs — an agent program's real reach is whatever its layer's transport already has.
 */

import type {Layer} from "effect";
import type {
	CapabilityRequest,
	DefinitionIdentity,
	PortSchema,
	Program,
	RendererRef,
} from "../registry/program.ts";
import {ProgramId} from "../registry/program.ts";
import {
	type AiAgentSessionCmd,
	type AiAgentSessionMsg,
	type AiAgentSessionState,
	type AiAgentSessionSub,
	aiAgentSessionMachine,
	checkpointWorthy,
	readCheckpoint,
} from "./core/index.ts";
import {
	type AiAgentHandlerError,
	type AiAgentHandlerServices,
	type AiAgentRetryPolicy,
	aiAgentHandlers,
	aiAgentPortNames,
} from "./handlers/index.ts";
import {
	type ModeSet,
	mode,
	type PermissionAnswer,
	type PromptPayload,
	permission,
	prompt,
	type TranscriptPageRequest,
	transcript,
	transcriptPage,
} from "./ports/index.ts";
import {resumeMessages} from "./restore/checkpoint.ts";
import type {TuvalAiAgent} from "./service/index.ts";

export interface AiAgentProgramConfig {
	/** The working directory a fresh session starts in. */
	readonly cwd: string;
	readonly itemLimit?: number;
	readonly byteLimit?: number;
	readonly policy?: AiAgentRetryPolicy;
}

export interface AiAgentProgramOptions<RIn = never> {
	readonly id: string;
	/**
	 * What this row runs on. A leftover requirement is not closed here: it lands on the row's own
	 * services and is satisfied at spawn, which is how a Claude row reaches the kernel services its
	 * bridge needs (#7951).
	 */
	readonly layer: Layer.Layer<TuvalAiAgent, never, RIn>;
	readonly config: AiAgentProgramConfig;
	readonly renderer?: RendererRef;
	/** What this row fills the desk inspector with while one of its windows has focus (#8190). */
	readonly inspector?: RendererRef;
	/** Merged over the row's own identity, for a caller that ships this program in its package. */
	readonly identity?: Partial<DefinitionIdentity>;
	readonly capabilities?: ReadonlyArray<CapabilityRequest>;
}

/**
 * What a row declares by being an ai-agent backend: how to reach its `TuvalAiAgent`.
 *
 * #8100 asked which surface carries this declaration, and it is this helper rather than a new
 * optional field on `Program` (`../registry/program.ts`). The helper already exists because every
 * backend shares one shape, so a row built through it is a backend by construction: `pi-session`
 * and `claude-session` both gain the declaration without a line of their own, a fourth backend
 * gains it by being built the same way, and the registry stays generic — it describes a program and
 * has no reason to name one program family's service. Walking it is `./backends.ts`.
 */
export interface AiAgentBackend<RIn = never> {
	/**
	 * The layer this row runs on — the same one `aiAgentHandlers` drives. `RIn` rides out unclosed
	 * (#7951), so an enumerator builds it under the kernel context a spawn of this row would use.
	 */
	readonly layer: Layer.Layer<TuvalAiAgent, never, RIn>;
}

export type AiAgentProgram<RIn = never> = Program<
	AiAgentSessionState,
	AiAgentSessionMsg,
	AiAgentSessionCmd,
	AiAgentSessionSub,
	unknown,
	AiAgentHandlerError,
	AiAgentHandlerServices<RIn>
> & {readonly aiAgent: AiAgentBackend<RIn>};

/**
 * Five kinds, eight keys: a kind whose protocol runs both ways is played from both ends by this one
 * program, and a kernel `ports` record holds one direction per key, so each end is named locally and
 * `compile` matches on the kind (`ports/ports.ts`).
 */
const portsOf = (): Readonly<Record<string, PortSchema>> => ({
	[aiAgentPortNames.transcript]: transcript.outbound(),
	[aiAgentPortNames.pageRequest]: transcriptPage.ends.request.inbound(),
	[aiAgentPortNames.pageReply]: transcriptPage.ends.page.outbound(),
	[aiAgentPortNames.prompt]: prompt.inbound(),
	[aiAgentPortNames.permissionPending]: permission.ends.pending.outbound(),
	[aiAgentPortNames.permissionDecision]: permission.ends.decision.inbound(),
	[aiAgentPortNames.modeState]: mode.ends.state.outbound(),
	[aiAgentPortNames.modeSet]: mode.ends.set.inbound(),
});

export const aiAgentProgram = <RIn = never>(
	options: AiAgentProgramOptions<RIn>,
): AiAgentProgram<RIn> => {
	const {handlers, subs} = aiAgentHandlers<RIn>({
		layer: options.layer,
		cwd: options.config.cwd,
		...(options.config.itemLimit === undefined ? {} : {itemLimit: options.config.itemLimit}),
		...(options.config.byteLimit === undefined ? {} : {byteLimit: options.config.byteLimit}),
		...(options.config.policy === undefined ? {} : {policy: options.config.policy}),
	});

	return {
		id: ProgramId.make(options.id),
		aiAgent: {layer: options.layer},
		core: aiAgentSessionMachine({
			cwd: options.config.cwd,
			...(options.config.itemLimit === undefined ? {} : {itemLimit: options.config.itemLimit}),
			...(options.config.byteLimit === undefined ? {} : {byteLimit: options.config.byteLimit}),
		}),
		ports: portsOf(),
		// Every receiver is a pure translation with nothing to refuse: each in-port admits exactly
		// the direction this end takes, so the kernel's `accepts` check turns an unstamped prompt
		// (#7991) and a wrong-direction payload (#8235) away at the send, where the caller reads it.
		receive: {
			[aiAgentPortNames.prompt]: (payload: PromptPayload) => ({
				type: "prompt",
				text: payload.text,
				key: payload.key,
				timestamp: payload.timestamp,
			}),
			[aiAgentPortNames.pageRequest]: (payload: TranscriptPageRequest) => ({
				type: "page",
				before: payload.before,
				limit: payload.limit,
			}),
			[aiAgentPortNames.permissionDecision]: (payload: PermissionAnswer) => ({
				type: "answer",
				request: payload.request,
				decision: payload.decision,
				...(payload.message === undefined ? {} : {message: payload.message}),
			}),
			[aiAgentPortNames.modeSet]: (payload: ModeSet) => ({type: "setMode", mode: payload.mode}),
		},
		handlers,
		subs,
		resume: resumeMessages,
		restorable: (raw) => readCheckpoint(raw, options.config.cwd) !== null,
		// One gate over both things that move per frame: a partial item, and a running subagent's
		// slot (`core/state.ts`). Without it every delta rewrites the transcript, and a stop mid-turn
		// saves the half-written reply as the reply (#8160).
		checkpointWorthy,
		capabilities: options.capabilities ?? [],
		...(options.renderer === undefined ? {} : {renderer: options.renderer}),
		...(options.inspector === undefined ? {} : {inspector: options.inspector}),
		identity: {
			package: "@kampus/tuval",
			program: options.id,
			version: "1.0.0",
			digest: `sha256:${options.id}`,
			...options.identity,
		},
		placement: {host: "local"},
	};
};
