/**
 * The six ports that make a process a Tuval AI agent, plus the two generic ones it fills like any
 * other program. Each declares one nominal kind, one payload predicate and one queue bound (#7512,
 * #7371); a program spreads the direction it plays into its own `ports` record and the kernel's
 * `compile` refuses a route between two different kinds before any process exists.
 *
 * `title` and `status` are not of this interface: they are the kernel's own `title@1`/`status@1`
 * (`../../process/self-report.ts`), which any program may declare and which say nothing about what
 * kind of program is talking (founder ruling R8.1 on #8715). They are listed here so a row builds
 * its whole `ports` record from one place, and they carry the kernel's kind and predicate rather
 * than a copy — a second copy of the kind string is how a title stops routing to a board.
 *
 * The bound rides the definition rather than the call site so every program admits the same depth
 * on a port — a window that queues a thousand prompts behind a stuck agent is the failure #7371
 * closed.
 *
 * A kernel `ports` record holds one direction per key, so a program playing both ends of a
 * two-way port (`transcript-page`, `permission`, `mode`) names each end locally — the kind is what
 * `compile` matches, not the key, so `pageRequest`/`pageReply` on one node route to their mirror
 * on the other and a cross-kind route still refuses. Each of those ends declares only its own
 * direction's predicate, so the kernel refuses a wrong-direction payload at the send (#8235).
 */

import {statusPort, titlePort} from "../../process/self-report.ts";
import type {InPort, OutPort, PortBound} from "../../registry/program.ts";
import {
	isModePayload,
	isModeSet,
	isModeState,
	isPermissionAnswer,
	isPermissionPayload,
	isPermissionPendingSet,
	isPromptPayload,
	isTranscriptPagePayload,
	isTranscriptPageReply,
	isTranscriptPageRequest,
	isTranscriptPayload,
	isTurnResult,
	type ModePayload,
	type ModeSet,
	type ModeState,
	type PermissionAnswer,
	type PermissionPayload,
	type PermissionPendingSet,
	type PromptPayload,
	type TranscriptPagePayload,
	type TranscriptPageReply,
	type TranscriptPageRequest,
	type TranscriptPayload,
	type TurnResult,
} from "./payloads.ts";

/**
 * One end of a port: what that end carries, and the values a program row's `ports` record holds
 * for it. `inbound` and `outbound` are those values; the end itself is the contract both nodes
 * type against.
 */
export interface PortEnd<P> {
	readonly kind: string;
	readonly bound: PortBound;
	readonly is: (payload: unknown) => payload is P;
	readonly inbound: (bound?: PortBound) => InPort<P>;
	readonly outbound: () => OutPort<P>;
}

/** What every port declares, whichever way its protocol runs. `is` admits the whole kind. */
export interface PortDefinition<P> {
	readonly name: string;
	readonly kind: string;
	readonly bound: PortBound;
	readonly is: (payload: unknown) => payload is P;
}

/** A port whose protocol runs one way: one payload, so the port is its own end. */
export interface AgentPort<P> extends PortDefinition<P>, PortEnd<P> {}

/**
 * A port whose protocol runs both ways, as the two ends it is played from (#8235).
 *
 * The union `is` is what `compile` type-matches — both ends carry the one kind, so the route
 * between them is compatible. What an end *admits* is its own direction's predicate, so a reply
 * written to the end that takes requests is refused by the kernel's `accepts` check at the send,
 * where the caller reads it, instead of one step later as a `failed` Msg only a rendering window
 * ever sees. That is the move #7991 made for `prompt`, applied to the three two-way kinds.
 */
export interface TwoWayPort<P, Ends extends Readonly<Record<string, P>>> extends PortDefinition<P> {
	readonly ends: {readonly [K in keyof Ends]: PortEnd<Ends[K]>};
}

const end = <P>(
	kind: string,
	bound: PortBound,
	is: (payload: unknown) => payload is P,
): PortEnd<P> => ({
	kind,
	bound,
	is,
	inbound: (override = bound) => ({kind, direction: "in", accepts: is, bound: override}),
	outbound: () => ({kind, direction: "out", accepts: is}),
});

const definePort = <P>(
	name: string,
	kind: string,
	bound: PortBound,
	is: (payload: unknown) => payload is P,
): AgentPort<P> => ({name, ...end(kind, bound, is)});

const defineTwoWayPort = <P, Ends extends Readonly<Record<string, P>>>(
	name: string,
	kind: string,
	bound: PortBound,
	is: (payload: unknown) => payload is P,
	ends: {readonly [K in keyof Ends]: (payload: unknown) => payload is Ends[K]},
): TwoWayPort<P, Ends> => ({
	name,
	kind,
	bound,
	is,
	// `Object.fromEntries` widens the keys to `string`, and the keys are the two ends this port
	// was declared with.
	ends: Object.fromEntries(
		Object.entries(ends).map(([direction, admits]) => [direction, end(kind, bound, admits)]),
	) as TwoWayPort<P, Ends>["ends"],
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

export const transcriptPage = defineTwoWayPort<
	TranscriptPagePayload,
	{request: TranscriptPageRequest; page: TranscriptPageReply}
>("transcript-page", "tuval/ai-agent/transcript-page@1", request, isTranscriptPagePayload, {
	request: isTranscriptPageRequest,
	page: isTranscriptPageReply,
});

export const prompt = definePort("prompt", "tuval/ai-agent/prompt@1", request, isPromptPayload);

export const permission = defineTwoWayPort<
	PermissionPayload,
	{decision: PermissionAnswer; pending: PermissionPendingSet}
>("permission", "tuval/ai-agent/permission@1", request, isPermissionPayload, {
	decision: isPermissionAnswer,
	pending: isPermissionPendingSet,
});

export const mode = defineTwoWayPort<ModePayload, {set: ModeSet; state: ModeState}>(
	"mode",
	"tuval/ai-agent/mode@1",
	snapshot,
	isModePayload,
	{set: isModeSet, state: isModeState},
);

/**
 * `result` — one payload per finished turn, for whatever consumes an agent's answer.
 *
 * `snapshot` rather than `request`: a turn's result supersedes the one before it, so a slow reader
 * should see the newest answer rather than hold the agent behind a queue of stale ones. That bound
 * is also what makes the kernel's `read` answer the *last* finished turn (`../../commands/core/
 * process.ts` keeps one value per out-port).
 */
export const result = definePort("result", "tuval/ai-agent/result@1", snapshot, isTurnResult);

/** The kernel's generic out-port, in this file's shape, so `agentPorts` is one list to walk. */
const generic = <P>(name: string, port: OutPort<P>, bound: PortBound): AgentPort<P> => ({
	name,
	...end(port.kind, bound, port.accepts),
});

/** `program · model · cwd`, re-said whenever one of the three changes (R3.1/R4.1 on #8715). */
export const title = generic("title", titlePort, snapshot);

/** One short line about how the process is doing. This program fills it from `../self-report.ts`. */
export const status = generic("status", statusPort, snapshot);

/** Every port a row built here declares, in declaration order, for a consumer walking them. */
export const agentPorts = [
	transcript,
	transcriptPage,
	prompt,
	permission,
	mode,
	result,
	title,
	status,
] as const;

export type AgentPortPayload =
	| TranscriptPayload
	| TranscriptPagePayload
	| PromptPayload
	| PermissionPayload
	| ModePayload
	| TurnResult
	/** What `title` and `status` carry: one line, and nothing else (`../../process/self-report.ts`). */
	| string;
