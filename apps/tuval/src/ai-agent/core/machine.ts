/**
 * `ai-agent-session` — the one core machine that drives any `TuvalAiAgent` layer.
 *
 * Generic by construction (founder ruling, 2026-09-02): the Pi row and the Claude row differ only
 * in the layer they provide, so nothing here names a backend and nothing here holds an Effect.
 * Each Cmd is the name of work a handler on the program row performs; the Sub is the name of the
 * layer's event stream, keyed by session id.
 *
 * Every refusal is data. A prompt outside `ready`, an answer to a card nobody raised, a mode the
 * agent does not offer: each records an `AgentFailure` and emits no Cmd, so a window renders the
 * refusal instead of a crash taking the process with it.
 */

import {defineMachine, type Machine} from "@demlik/tea";
import {
	modeUnsupported,
	noSessionToResume,
	promptRefused,
	START_ERROR,
	startRefused,
	unknownRequest,
} from "./failures.ts";
import {foldEvent, type WindowLimits} from "./fold.ts";
import {
	type AiAgentSessionCmd,
	type AiAgentSessionMsg,
	type AiAgentSessionSub,
	eventsSub,
} from "./messages.ts";
import {
	type AgentFailure,
	type AiAgentSessionState,
	initialState,
	lastAssistantId,
	restore,
} from "./state.ts";

export interface AiAgentSessionOptions extends WindowLimits {
	/** The working directory a fresh session starts in. */
	readonly cwd: string;
}

export type AiAgentSessionMachine = Machine<
	AiAgentSessionState,
	AiAgentSessionMsg,
	AiAgentSessionCmd,
	AiAgentSessionSub,
	unknown
>;

const noCmds = [] as const;

const noWork = (): Promise<void> => Promise.resolve();

/** A phase a start would trample: a session is already opening, open or coming back. */
const busy = (state: AiAgentSessionState): boolean =>
	state.phase !== "idle" && state.phase !== "gone";

/** An open is already in flight, so a second one would build a second transport. */
const opening = (state: AiAgentSessionState): boolean =>
	state.phase === "starting" || state.phase === "reconnecting";

/** The backend does not hold the session this resume named. */
const sessionGone = (failure: AgentFailure): boolean =>
	failure.tag === START_ERROR && failure.reason === "session-not-found";

/**
 * Where a failure leaves a session: back where it was before the act that failed.
 *
 * A resume is the exception, because there is nowhere before it to go back to. A refused resume
 * ends the session at `gone` — the id the checkpoint carried names nothing the backend still
 * holds, and the one thing that must never happen is a fresh session opening quietly in its place
 * (#7514). Any other reconnect failure is a transport that can be tried again, so it lands on
 * `idle` rather than staying at `reconnecting`, which the reconnect guard itself would refuse.
 */
const phaseAfterFailure = (
	state: AiAgentSessionState,
	failure: AgentFailure,
): AiAgentSessionState["phase"] => {
	if (state.phase === "reconnecting") return sessionGone(failure) ? "gone" : "idle";
	if (state.phase === "starting") return "idle";
	if (state.phase === "prompting") return "ready";
	return state.phase;
};

export const aiAgentSessionMachine = (options: AiAgentSessionOptions): AiAgentSessionMachine => {
	const limits: WindowLimits = {
		...(options.itemLimit === undefined ? {} : {itemLimit: options.itemLimit}),
		...(options.byteLimit === undefined ? {} : {byteLimit: options.byteLimit}),
	};
	return defineMachine<
		AiAgentSessionState,
		AiAgentSessionMsg,
		AiAgentSessionCmd,
		AiAgentSessionSub,
		unknown
	>({
		init: (loaded) => [loaded === null ? initialState(options.cwd) : restore(loaded), noCmds],
		update: {
			start: (state, msg) =>
				busy(state)
					? [{...state, failure: startRefused(state.phase)}, noCmds]
					: [
							{
								...state,
								phase: "starting",
								cwd: msg.cwd,
								sessionId: null,
								permissions: {},
								lastPage: null,
								failure: null,
							},
							[{type: "aiAgent.start", cwd: msg.cwd, resume: msg.resume}],
						],

			// The connection bump is what re-opens the events Sub: a reconnect stands a new transport
			// up under the same session id, and the Sub is reconciled by id (`messages.ts`).
			started: (state, msg) =>
				state.phase === "gone"
					? [state, noCmds]
					: [
							{
								...state,
								phase: "ready",
								sessionId: msg.sessionId,
								connection: state.connection + 1,
								failure: null,
							},
							noCmds,
						],

			prompt: (state, msg) =>
				state.phase !== "ready"
					? [{...state, failure: promptRefused(state.phase)}, noCmds]
					: [
							{
								...state,
								phase: "prompting",
								lastPrompt: msg.text,
								interrupted: null,
								failure: null,
							},
							[{type: "aiAgent.prompt", text: msg.text, key: msg.key}],
						],

			// A closed session keeps whatever it ended with: a late frame from a torn-down transport
			// must not resurrect a phase or grow a tail nobody is watching.
			event: (state, msg) =>
				state.phase === "gone" ? [state, noCmds] : [foldEvent(state, msg.event, limits), noCmds],

			answer: (state, msg) =>
				state.permissions[msg.request] === undefined
					? [{...state, failure: unknownRequest(msg.request)}, noCmds]
					: [
							{
								...state,
								permissions: Object.fromEntries(
									Object.entries(state.permissions).filter(([id]) => id !== msg.request),
								),
								failure: null,
							},
							[
								{
									type: "aiAgent.answer",
									request: msg.request,
									decision: msg.decision,
									...(msg.message === undefined ? {} : {message: msg.message}),
								},
							],
						],

			setMode: (state, msg) =>
				state.modes.available.includes(msg.mode)
					? [{...state, failure: null}, [{type: "aiAgent.setMode", mode: msg.mode}]]
					: [{...state, failure: modeUnsupported(msg.mode, state.modes.available)}, noCmds],

			page: (state, msg) => [state, [{type: "aiAgent.page", before: msg.before, limit: msg.limit}]],

			paged: (state, msg) => [{...state, lastPage: msg.page}, noCmds],

			interrupt: (state) =>
				state.phase !== "prompting"
					? [state, noCmds]
					: [
							{
								...state,
								phase: "ready",
								interrupted: lastAssistantId(state.transcript.items),
							},
							[{type: "aiAgent.interrupt"}],
						],

			reconnect: (state) => {
				if (state.sessionId === null) return [{...state, failure: noSessionToResume}, noCmds];
				// The same guard `start` carries, for the same reason: the handler rebuilds the layer,
				// so two overlapping opens would build two transports into one process Scope.
				if (opening(state)) return [{...state, failure: startRefused(state.phase)}, noCmds];
				// The republish goes first so a window attached to a restored session paints the saved
				// tail and its pending cards before the transport is back, rather than after it.
				return [
					{...state, phase: "reconnecting"},
					[
						{type: "aiAgent.republish"},
						{type: "aiAgent.reconnect", cwd: state.cwd, sessionId: state.sessionId},
					],
				];
			},

			failed: (state, msg) => [
				{...state, phase: phaseAfterFailure(state, msg.failure), failure: msg.failure},
				noCmds,
			],
		},

		subscriptions: (state) =>
			state.sessionId === null || state.phase === "gone"
				? []
				: [eventsSub(state.sessionId, state.connection)],

		identity: {
			ofState: (state) => state.sessionId,
			ofMsg: (msg) => (msg.type === "event" ? msg.sessionId : undefined),
		},

		// Demlik's `Machine` demands a Promise `interpret` and a `subscribe` beside the row's own
		// Effect handlers; the host reads neither (#7576).
		interpret: {
			"aiAgent.start": noWork,
			"aiAgent.prompt": noWork,
			"aiAgent.answer": noWork,
			"aiAgent.setMode": noWork,
			"aiAgent.page": noWork,
			"aiAgent.interrupt": noWork,
			"aiAgent.reconnect": noWork,
			"aiAgent.republish": noWork,
		},
		subscribe: {"aiAgent.events": () => () => {}},
	});
};
