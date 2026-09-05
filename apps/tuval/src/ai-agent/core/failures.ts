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
export const PAGE_ERROR = "tuval/ai-agent/PageError";

/**
 * An inbound payload this end of a port cannot act on, written against that port's own tag.
 *
 * The tag has to be the port's, because the window renders by tag (ruling 3, #7570) and a
 * misdirected mode-set shown as a prompt error lands in the wrong place. `refused` is not a case
 * any of these classes enumerates, and that is deliberate — like `deadlineFailure`, this refusal is
 * the graph's mistake and not one the backend can raise.
 */
export const portRefused = (tag: string, detail: string): AgentFailure => ({
	tag,
	reason: "refused",
	detail,
});

export const startRefused = (phase: string): AgentFailure => ({
	tag: START_ERROR,
	reason: "session-locked",
	detail: `a session is already ${phase}`,
});

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

export const unknownRequest = (request: string): AgentFailure => ({
	tag: UNKNOWN_REQUEST,
	reason: null,
	detail: `no permission request "${request}" is pending`,
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
