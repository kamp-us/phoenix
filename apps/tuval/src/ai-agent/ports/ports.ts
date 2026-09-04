/**
 * The five ports that make a process a Tuval AI agent. Each declares one nominal kind, one payload
 * predicate and one queue bound (#7512, #7371); a program spreads the direction it plays into its
 * own `ports` record and the kernel's `compile` refuses a route between two different kinds before
 * any process exists.
 *
 * The bound rides the definition rather than the call site so every program admits the same depth
 * on a port — a window that queues a thousand prompts behind a stuck agent is the failure #7371
 * closed.
 *
 * A kernel `ports` record holds one direction per key, so a program playing both ends of a
 * two-way port (`transcript-page`, `permission`, `mode`) names each end locally — the kind is what
 * `compile` matches, not the key, so `pageRequest`/`pageReply` on one node route to their mirror
 * on the other and a cross-kind route still refuses.
 */

import type {InPort, OutPort, PortBound} from "../../registry/program.ts";
import {
	isModePayload,
	isPermissionPayload,
	isPromptPayload,
	isTranscriptPagePayload,
	isTranscriptPayload,
	type ModePayload,
	type PermissionPayload,
	type PromptPayload,
	type TranscriptPagePayload,
	type TranscriptPayload,
} from "./payloads.ts";

/**
 * One port of the interface, in whichever direction a given program plays it. `inbound` and
 * `outbound` are the values a program row's `ports` record holds; the definition itself is the
 * contract both ends type against.
 */
export interface AgentPort<P> {
	readonly name: string;
	readonly kind: string;
	readonly bound: PortBound;
	readonly is: (payload: unknown) => payload is P;
	readonly inbound: (bound?: PortBound) => InPort<P>;
	readonly outbound: () => OutPort<P>;
}

const definePort = <P>(
	name: string,
	kind: string,
	bound: PortBound,
	is: (payload: unknown) => payload is P,
): AgentPort<P> => ({
	name,
	kind,
	bound,
	is,
	inbound: (override = bound) => ({kind, direction: "in", accepts: is, bound: override}),
	outbound: () => ({kind, direction: "out", accepts: is}),
});

/**
 * A snapshot supersedes the one before it, so a slow reader should see the newest tail rather than
 * block the program that computed it.
 */
const snapshot: PortBound = {capacity: 8, overflow: "sliding"};

/** A request or an answer is an operator act: losing one is a bug, so a full queue suspends. */
const request: PortBound = {capacity: 32, overflow: "suspend"};

export const transcript = definePort(
	"transcript",
	"tuval/ai-agent/transcript@1",
	snapshot,
	isTranscriptPayload,
);

export const transcriptPage = definePort(
	"transcript-page",
	"tuval/ai-agent/transcript-page@1",
	request,
	isTranscriptPagePayload,
);

export const prompt = definePort("prompt", "tuval/ai-agent/prompt@1", request, isPromptPayload);

export const permission = definePort(
	"permission",
	"tuval/ai-agent/permission@1",
	request,
	isPermissionPayload,
);

export const mode = definePort("mode", "tuval/ai-agent/mode@1", snapshot, isModePayload);

/** The whole interface, in declaration order, for a consumer that wants to walk it. */
export const agentPorts = [transcript, transcriptPage, prompt, permission, mode] as const;

export type AgentPortPayload =
	| TranscriptPayload
	| TranscriptPagePayload
	| PromptPayload
	| PermissionPayload
	| ModePayload;
