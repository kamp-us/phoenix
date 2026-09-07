/**
 * The tags and cases the core's own refusals speak.
 *
 * They are the tags of the layer's error classes, written as literals because the core may import
 * nothing from `src/ai-agent/service/` (#7601). A refusal the core raises reads the same to the
 * window as the equivalent failure from the layer, which is the point — one vocabulary, rendered
 * by tag (ruling 3, #7570). `boundary.unit.test.ts` reads `service/errors.ts` as text and reds if
 * any literal here stops naming a tag that file declares.
 */

import type {AgentFailure} from "./state.ts";

export const START_ERROR = "tuval/ai-agent/StartError";
export const PROMPT_ERROR = "tuval/ai-agent/PromptError";
export const UNKNOWN_REQUEST = "tuval/ai-agent/UnknownRequest";
export const MODE_UNSUPPORTED = "tuval/ai-agent/ModeUnsupported";
export const MODEL_UNSUPPORTED = "tuval/ai-agent/ModelUnsupported";
export const THINKING_UNSUPPORTED = "tuval/ai-agent/ThinkingUnsupported";
export const PAGE_ERROR = "tuval/ai-agent/PageError";
export const TRANSPORT_ERROR = "tuval/ai-agent/TransportError";
/** The refused interrupt (ADR 0356). No core cell raises it — only an adapter that was refused. */
export const INTERRUPT_ERROR = "tuval/ai-agent/InterruptError";

export const startRefused = (phase: string): AgentFailure => ({
	tag: START_ERROR,
	reason: "session-locked",
	detail: `a session is already ${phase}`,
});

/**
 * A checkpoint that is still not a session state once its absent fields are defaulted (#8095).
 *
 * It wears `START_ERROR` because the window's status line renders a start failure at the phase the
 * session came to rest in (`shell/chat/phase.ts`), and a refused checkpoint rests at `gone`: the
 * operator reads "The session is gone — …" instead of a fresh window that accounts for nothing.
 */
export const checkpointUnreadable: AgentFailure = {
	tag: START_ERROR,
	reason: "refused",
	detail: "the saved checkpoint is not a readable session, so nothing was restored from it",
};

export const noSessionToResume: AgentFailure = {
	tag: START_ERROR,
	reason: "session-not-found",
	detail: "there is no session id to reconnect to",
};

export const promptRefused = (phase: string): AgentFailure => ({
	tag: PROMPT_ERROR,
	reason: "no-session",
	detail: `the session is ${phase}, not ready`,
});

/**
 * The queue behind a running turn is full, so this prompt waits nowhere (`./queue.ts`).
 *
 * `refused` rather than `no-session`, because the session is perfectly alive and the text provably
 * never crossed — which is also what routes it to the recoverable arm in `./sends.ts`.
 */
export const promptQueueFull = (limit: number): AgentFailure => ({
	tag: PROMPT_ERROR,
	reason: "refused",
	detail: `${limit} messages are already waiting behind the running turn`,
});

/** A queued prompt released back to its window because the turn it was waiting for will not end. */
export const promptUnqueued = (why: string): AgentFailure => ({
	tag: PROMPT_ERROR,
	reason: "refused",
	detail: `the queued message was not sent: ${why}`,
});

export const unknownRequest = (request: string): AgentFailure => ({
	tag: UNKNOWN_REQUEST,
	reason: null,
	detail: `no permission request "${request}" is pending`,
});

/**
 * A second answer to a card whose first one is not settled — a repeated click, or the other window
 * over this process (#8006). It wears the answer call's own tag so the window renders it beside the
 * card, and a `reason` no error class enumerates: the refusal is the core's, and no backend can
 * raise it.
 */
export const answerNotOffered = (
	request: string,
	status: "answering" | "unresolved",
): AgentFailure => ({
	tag: UNKNOWN_REQUEST,
	reason: status === "answering" ? "awaiting-confirmation" : "unresolved",
	detail:
		status === "answering"
			? `permission request "${request}" is already answered and awaiting confirmation`
			: `permission request "${request}" has an answer whose outcome is unknown; only the agent can settle it`,
});

export const modeUnsupported = (mode: string, available: ReadonlyArray<string>): AgentFailure => ({
	tag: MODE_UNSUPPORTED,
	reason: null,
	detail: `mode "${mode}" is not offered; available: ${available.join(", ") || "none"}`,
});

export const modelUnsupported = (
	model: string,
	available: ReadonlyArray<string>,
): AgentFailure => ({
	tag: MODEL_UNSUPPORTED,
	reason: null,
	detail: `model "${model}" is not offered; available: ${available.join(", ") || "none"}`,
});

export const thinkingUnsupported = (
	level: string,
	available: ReadonlyArray<string>,
): AgentFailure => ({
	tag: THINKING_UNSUPPORTED,
	reason: null,
	detail: `thinking level "${level}" is not offered; available: ${available.join(", ") || "none"}`,
});
