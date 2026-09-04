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
	PROMPT_ERROR,
} from "./core/index.ts";
import {
	type AiAgentHandlerError,
	type AiAgentHandlerServices,
	type AiAgentRetryPolicy,
	aiAgentHandlers,
	aiAgentPortNames,
} from "./handlers/index.ts";
import {
	type ModePayload,
	mode,
	type PermissionPayload,
	type PromptPayload,
	permission,
	prompt,
	type TranscriptPagePayload,
	transcript,
	transcriptPage,
} from "./ports/index.ts";
import type {TuvalAiAgent} from "./service/index.ts";

export interface AiAgentProgramConfig {
	/** The working directory a fresh session starts in. */
	readonly cwd: string;
	readonly itemLimit?: number;
	readonly byteLimit?: number;
	readonly policy?: AiAgentRetryPolicy;
}

export interface AiAgentProgramOptions {
	readonly id: string;
	readonly layer: Layer.Layer<TuvalAiAgent>;
	readonly config: AiAgentProgramConfig;
	readonly renderer?: RendererRef;
	/** Merged over the row's own identity, for a caller that ships this program in its package. */
	readonly identity?: Partial<DefinitionIdentity>;
	readonly capabilities?: ReadonlyArray<CapabilityRequest>;
}

export type AiAgentProgram = Program<
	AiAgentSessionState,
	AiAgentSessionMsg,
	AiAgentSessionCmd,
	AiAgentSessionSub,
	unknown,
	AiAgentHandlerError,
	AiAgentHandlerServices
>;

/**
 * An inbound payload this end of a two-way port cannot act on, as data.
 *
 * A port kind admits both directions' payloads (`ports/payloads.ts` carries one tagged type per
 * kind), so the checker cannot rule out a `page` arriving where a request belongs — and neither
 * can a receiver, which is a pure translation with no channel to fail on. Refusing as a `failed`
 * Msg keeps the port's own invariant visible in the window instead of throwing inside the pump.
 */
const refuse = (detail: string): AiAgentSessionMsg => ({
	type: "failed",
	failure: {tag: PROMPT_ERROR, reason: "refused", detail},
});

/**
 * Five kinds, eight keys: a kind whose protocol runs both ways is played from both ends by this one
 * program, and a kernel `ports` record holds one direction per key, so each end is named locally and
 * `compile` matches on the kind (`ports/ports.ts`).
 */
const portsOf = (): Readonly<Record<string, PortSchema>> => ({
	[aiAgentPortNames.transcript]: transcript.outbound(),
	[aiAgentPortNames.pageRequest]: transcriptPage.inbound(),
	[aiAgentPortNames.pageReply]: transcriptPage.outbound(),
	[aiAgentPortNames.prompt]: prompt.inbound(),
	[aiAgentPortNames.permissionPending]: permission.outbound(),
	[aiAgentPortNames.permissionDecision]: permission.inbound(),
	[aiAgentPortNames.modeState]: mode.outbound(),
	[aiAgentPortNames.modeSet]: mode.inbound(),
});

export const aiAgentProgram = (options: AiAgentProgramOptions): AiAgentProgram => {
	const {handlers, subs} = aiAgentHandlers({
		layer: options.layer,
		cwd: options.config.cwd,
		...(options.config.itemLimit === undefined ? {} : {itemLimit: options.config.itemLimit}),
		...(options.config.byteLimit === undefined ? {} : {byteLimit: options.config.byteLimit}),
		...(options.config.policy === undefined ? {} : {policy: options.config.policy}),
	});

	return {
		id: ProgramId.make(options.id),
		core: aiAgentSessionMachine({
			cwd: options.config.cwd,
			...(options.config.itemLimit === undefined ? {} : {itemLimit: options.config.itemLimit}),
			...(options.config.byteLimit === undefined ? {} : {byteLimit: options.config.byteLimit}),
		}),
		ports: portsOf(),
		receive: {
			[aiAgentPortNames.prompt]: (payload: PromptPayload) =>
				payload.key === undefined
					? refuse(`a prompt arrived with no idempotency key: "${payload.text}"`)
					: {type: "prompt", text: payload.text, key: payload.key},
			[aiAgentPortNames.pageRequest]: (payload: TranscriptPagePayload) =>
				payload.kind === "request"
					? {type: "page", before: payload.before, limit: payload.limit}
					: refuse("a page arrived on the request end of transcript-page"),
			[aiAgentPortNames.permissionDecision]: (payload: PermissionPayload) =>
				payload.kind === "decision"
					? {type: "answer", request: payload.request, decision: payload.decision}
					: refuse("a pending set arrived on the answer end of permission"),
			[aiAgentPortNames.modeSet]: (payload: ModePayload) =>
				payload.kind === "set"
					? {type: "setMode", mode: payload.mode}
					: refuse("a mode state arrived on the set end of mode"),
		},
		handlers,
		subs,
		capabilities: options.capabilities ?? [],
		...(options.renderer === undefined ? {} : {renderer: options.renderer}),
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
