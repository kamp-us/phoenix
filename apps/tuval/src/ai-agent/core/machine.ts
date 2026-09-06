/**
 * `ai-agent-session` — the one core machine that drives any `TuvalAiAgent` layer.
 *
 * Generic by construction (founder ruling, 2026-09-02): the Pi row and the Claude row differ only
 * in the layer they provide, so nothing here names a backend and nothing here holds an Effect.
 * Each Cmd is the name of work a handler on the program row performs; the Sub is the name of the
 * layer's event stream, keyed by session id.
 *
 * Every refusal is data. A prompt the session cannot take, an answer to a card nobody raised, a mode
 * the agent does not offer: each records an `AgentFailure` and emits no Cmd, so a window renders the
 * refusal instead of a crash taking the process with it.
 *
 * A prompt written *during* a turn is the one that is not a refusal: it queues (`./queue.ts`), and
 * the turn's own end admits it.
 */

import {defineMachine, type Machine} from "@demlik/tea";
import {sameModel} from "../ports/index.ts";
import {
	answerNotOffered,
	modelUnsupported,
	modeUnsupported,
	noSessionToResume,
	promptQueueFull,
	promptRefused,
	promptUnqueued,
	startRefused,
	thinkingUnsupported,
	UNKNOWN_REQUEST,
	unknownRequest,
} from "./failures.ts";
import {
	awaitingAnswer,
	dropRequest,
	foldEvent,
	foldItem,
	interruptionAfter,
	phaseAfterFailure,
	promptItem,
	unresolvedAnswer,
	type WindowLimits,
} from "./fold.ts";
import {
	type AiAgentSessionCmd,
	type AiAgentSessionMsg,
	type AiAgentSessionSub,
	eventsSub,
} from "./messages.ts";
import {enqueue, isQueueFull, type QueuedPrompt, queueLimit, releaseQueued} from "./queue.ts";
import {noteSend, settledBy, settlePending} from "./sends.ts";
import {loadCheckpoint} from "./snapshot.ts";
import {type AiAgentSessionState, initialState, lastAssistantId} from "./state.ts";

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

type Step = readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>];

/** A phase a start would trample: a session is already opening, open or coming back. */
const busy = (state: AiAgentSessionState): boolean =>
	state.phase !== "idle" && state.phase !== "gone";

/** An open is already in flight, so a second one would build a second transport. */
const opening = (state: AiAgentSessionState): boolean =>
	state.phase === "starting" || state.phase === "reconnecting";

export const aiAgentSessionMachine = (options: AiAgentSessionOptions): AiAgentSessionMachine => {
	const limits: WindowLimits = {
		...(options.itemLimit === undefined ? {} : {itemLimit: options.itemLimit}),
		...(options.byteLimit === undefined ? {} : {byteLimit: options.byteLimit}),
	};

	/** One prompt admitted: the tail records the turn, the send goes pending, the layer is told. */
	const admit = (state: AiAgentSessionState, prompt: QueuedPrompt): Step => [
		{
			...state,
			phase: "prompting",
			lastPrompt: prompt.text,
			interrupted: null,
			interruption: null,
			transcript: foldItem(state.transcript, promptItem(prompt), limits),
			sends: noteSend(state.sends, {key: prompt.key, state: "pending"}),
			failure: null,
		},
		[{type: "aiAgent.prompt", text: prompt.text, key: prompt.key}],
	];

	/**
	 * What a committed transition owes the queue, applied to every cell that can land the session
	 * somewhere the queue's answer changes.
	 *
	 * A session back at `ready` is the running turn having ended, which is the one event a queued
	 * prompt waits for — so its head is admitted here, on the same commit, and the window never sees
	 * a gap where the agent looks idle with work still queued. A session at `gone` or `idle` will
	 * never end that turn, so what is queued is released to the operator instead (`./queue.ts`).
	 * Every other phase leaves the queue exactly where it stands.
	 */
	const settleQueue = (step: Step): Step => {
		const [state, cmds] = step;
		const [head, ...rest] = state.queued;
		if (head === undefined) return step;
		if (state.phase === "ready") {
			const [next, admitted] = admit({...state, queued: rest}, head);
			return [next, [...cmds, ...admitted]];
		}
		if (state.phase !== "gone" && state.phase !== "idle") return step;
		return [
			{
				...state,
				queued: [],
				sends: releaseQueued(
					state.queued,
					state.sends,
					promptUnqueued("the session ended before the turn it was waiting for did"),
				),
			},
			cmds,
		];
	};

	return defineMachine<
		AiAgentSessionState,
		AiAgentSessionMsg,
		AiAgentSessionCmd,
		AiAgentSessionSub,
		unknown
	>({
		/**
		 * A fresh process opens its own session; a restored one is left to its resume rule.
		 *
		 * Spawning the program is the whole act (#7925): before this, every `start` in the tree was
		 * a test's, so a picker-opened window sat at `idle` refusing every prompt. The fresh arm is
		 * the home because it is the only place that knows the process is new, and it covers every
		 * spawner at once — the picker, the launcher, a test kernel — where a hook on one spawn path
		 * is a hook the next spawn path forgets, which is the bug itself. The window is not the home
		 * either: two windows over one process would race into `startRefused`, and a window is a
		 * view rather than the owner of a session's lifetime.
		 *
		 * Demlik allows this exactly here. Its guard reds only on a **non-null** `loaded` whose
		 * `init` returns Cmds — the rehydrate branch is the migration/parse boundary (`replay` in
		 * `@demlik/tea` 0.12) — so the restored arm stays `noCmds` and its reconnect stays the Msg
		 * `restore/checkpoint.ts` hands a spawner.
		 */
		init: (loaded) =>
			loaded === null
				? [initialState(options.cwd), [{type: "aiAgent.boot", cwd: options.cwd}]]
				: [loadCheckpoint(loaded, options.cwd), noCmds],
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
								interruption: null,
								failure: null,
							},
							[
								{
									type: "aiAgent.start",
									cwd: msg.cwd,
									resume: msg.resume,
									mode: state.modes.current,
								},
							],
						],

			// The connection bump is what re-opens the events Sub: a reconnect stands a new transport
			// up under the same session id, and the Sub is reconciled by id (`messages.ts`).
			started: (state, msg) =>
				state.phase === "gone"
					? [state, noCmds]
					: settleQueue([
							{
								...state,
								phase: "ready",
								sessionId: msg.sessionId,
								connection: state.connection + 1,
								interruption: null,
								failure: null,
							},
							noCmds,
						]),

			// The turn goes onto the tail in `admit`, not when a layer reports it back: the message
			// exists because the operator sent it, and a backend's echo habits are not what a chat
			// window showing your own message should depend on (#7978).
			//
			// A prompt written while the turn runs waits rather than being refused (#8159). Its send
			// is recorded by nothing yet — neither refused nor in the layer's hands is the truth about
			// it, and `readHeld` (`shell/chat/outgoing.ts`) reads a key it has no outcome for as
			// "wait", which is exactly right. The refusing arms do record one, because a refusal is
			// final and the window that minted the key is waiting on it (#8005).
			prompt: (state, msg) => {
				if (state.phase === "prompting") {
					if (!isQueueFull(state.queued)) {
						return [
							{
								...state,
								queued: enqueue(state.queued, {
									key: msg.key,
									text: msg.text,
									timestamp: msg.timestamp,
								}),
								failure: null,
							},
							noCmds,
						];
					}
					const full = promptQueueFull(queueLimit);
					return [
						{...state, failure: full, sends: noteSend(state.sends, settledBy(msg.key, full))},
						noCmds,
					];
				}
				return state.phase === "ready"
					? admit(state, msg)
					: [
							{
								...state,
								failure: promptRefused(state.phase),
								sends: noteSend(state.sends, settledBy(msg.key, promptRefused(state.phase))),
							},
							noCmds,
						];
			},

			// The prompt handler's own answer, and the only refusal that arrives already correlated
			// to the send it is about. A refusal lands the session exactly where the `failed` cell
			// would — same phase walk, same rendered failure — and additionally settles the send, so
			// the prompt path has one Msg rather than two that could disagree.
			//
			// A `sent` carrying no failure settles nothing, and that is the point. Both rows return
			// from `prompt` at the send (#8018), so silence here proves only that the layer did not
			// refuse the handoff — the backend has not answered yet, and a send marked `accepted`
			// on this Msg would have its window drop the text a refusal two round trips later can
			// no longer give back (#8005). The send stays `pending` until the turn's end says the
			// backend had it (`./fold.ts`, the `phase` arm) or a failure settles it.
			sent: (state, msg) =>
				msg.failure === null
					? [state, noCmds]
					: settleQueue([
							{
								...state,
								phase: phaseAfterFailure(state, msg.failure),
								failure: msg.failure,
								sends: noteSend(state.sends, settledBy(msg.key, msg.failure)),
							},
							noCmds,
						]),

			// A closed session keeps whatever it ended with: a late frame from a torn-down transport
			// must not resurrect a phase or grow a tail nobody is watching.
			event: (state, msg) =>
				state.phase === "gone"
					? [state, noCmds]
					: settleQueue([foldEvent(state, msg.event, limits), noCmds]),

			// The card stays, marked `answering`, until a confirmation clears it (#8006): a card that
			// left on the click would read as an answer that succeeded before its outcome was known,
			// and the other window over this process would lose it too.
			answer: (state, msg) => {
				const held = state.permissions[msg.request];
				if (held === undefined) return [{...state, failure: unknownRequest(msg.request)}, noCmds];
				if (held.progress.status !== "open") {
					return [{...state, failure: answerNotOffered(msg.request, held.progress.status)}, noCmds];
				}
				return [
					{
						...state,
						permissions: {
							...state.permissions,
							[msg.request]: {...held, progress: {status: "answering", decision: msg.decision}},
						},
						failure: null,
					},
					// The republish goes first, for `reconnect`'s reason: the pending set is an outbound
					// projection nothing but an event pushes, and the mark this commit just made rides
					// no event, so a window routed over the port would never see it (#7979's shape).
					[
						{type: "aiAgent.republish"},
						{
							type: "aiAgent.answer",
							request: msg.request,
							seq: held.seq,
							decision: msg.decision,
							...(msg.message === undefined ? {} : {message: msg.message}),
						},
					],
				];
			},

			answered: (state, msg) =>
				awaitingAnswer(state, msg.request, msg.seq) === null
					? [state, noCmds]
					: [{...dropRequest(state, msg.request), failure: null}, [{type: "aiAgent.republish"}]],

			// The three outcomes the criteria keep apart: the backend says the request is gone, so the
			// card goes with it; anything else leaves the answer's fate unknown, and an `unresolved`
			// card offers no second answer, because the authorization it carried may already stand.
			answerFailed: (state, msg) => {
				const held = awaitingAnswer(state, msg.request, msg.seq);
				if (held === null) return [state, noCmds];
				const settled = msg.failure.tag === UNKNOWN_REQUEST;
				return [
					{
						...(settled
							? dropRequest(state, msg.request)
							: unresolvedAnswer(state, msg.request, held)),
						failure: msg.failure,
					},
					[{type: "aiAgent.republish"}],
				];
			},

			setMode: (state, msg) =>
				state.modes.available.includes(msg.mode)
					? [{...state, failure: null}, [{type: "aiAgent.setMode", mode: msg.mode}]]
					: [{...state, failure: modeUnsupported(msg.mode, state.modes.available)}, noCmds],

			// The offered list is the whole guard, exactly as `setMode`'s is: a pick the layer never
			// advertised is refused here rather than being sent for the layer to refuse again.
			setModel: (state, msg) =>
				state.models.available.some((offered) => sameModel(offered, msg.model))
					? [{...state, failure: null}, [{type: "aiAgent.setModel", model: msg.model}]]
					: [
							{
								...state,
								failure: modelUnsupported(
									msg.model.id,
									state.models.available.map((offered) => offered.id),
								),
							},
							noCmds,
						],

			// The offered set is the guard, exactly as `setModel`'s is, and it is the set the layer
			// advertised for the model this session is running on — Claude's five, Pi's seven or its
			// `off` alone (#8062).
			setThinkingLevel: (state, msg) =>
				state.thinking.available.includes(msg.level)
					? [{...state, failure: null}, [{type: "aiAgent.setThinkingLevel", level: msg.level}]]
					: [{...state, failure: thinkingUnsupported(msg.level, state.thinking.available)}, noCmds],

			page: (state, msg) => [state, [{type: "aiAgent.page", before: msg.before, limit: msg.limit}]],

			paged: (state, msg) => [{...state, lastPage: msg.page}, noCmds],

			/**
			 * Asking the backend to stop is not the backend having stopped (#8007).
			 *
			 * The session stays `prompting` and records the request; the `ready` a layer emits when
			 * the turn actually ends is what moves it, folded by `foldEvent` like any other phase.
			 * Both layers already emit it — Pi's snapshot fan reports the session back at `idle`
			 * (`pi/ai-agent/items.ts`, `phaseOf`) and Claude's pump emits it on every `result`
			 * message, aborted turns included (`claude/agent/ClaudeAiAgent.ts`, `drive`) — so
			 * waiting for confirmation needs nothing new on the interface.
			 *
			 * That is also why the send in flight is left exactly where it stood. `prompting` is
			 * reached at admission rather than on the layer's confirmation, so an Escape pressed
			 * while `aiAgent.prompt` is still in flight interrupts a turn the layer may yet refuse;
			 * the layer's own `sent` settles a refused handoff, and the turn's end accepts a send
			 * that really ran (`./fold.ts`, the `phase` arm). Neither answer is this cell's to give
			 * (#8005).
			 *
			 * The cut-turn marker is set here rather than on confirmation because it is the
			 * operator's act being recorded, and the resend it offers is theirs to spend. A second
			 * press re-sends the abort and keeps the first `requestedAt`: the window measures how
			 * long the interruption has been outstanding, and that clock starts when they first
			 * asked.
			 *
			 * The queue goes, because an operator asking a turn to stop is not asking the next queued
			 * one to start. It is released rather than dropped, so every word is still theirs to take
			 * back (`./queue.ts`).
			 */
			interrupt: (state, msg) =>
				state.phase !== "prompting"
					? [state, noCmds]
					: [
							{
								...state,
								interrupted: state.interrupted ?? lastAssistantId(state.transcript.items),
								interruption: state.interruption ?? {requestedAt: msg.at},
								queued: [],
								sends: releaseQueued(
									state.queued,
									state.sends,
									promptUnqueued("the turn it was waiting for was interrupted"),
								),
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
				//
				// The checkpointed mode rides the reconnect for the same reason it cannot ride a
				// `setMode` after `started`: a rebuilt layer holds no mode, so one told after the open
				// would run a stretch of session on the row's configured mode and say so (#7953).
				return [
					{...state, phase: "reconnecting", interruption: null},
					[
						{type: "aiAgent.republish"},
						{
							type: "aiAgent.reconnect",
							cwd: state.cwd,
							sessionId: state.sessionId,
							mode: state.modes.current,
						},
					],
				];
			},

			failed: (state, msg) => {
				const phase = phaseAfterFailure(state, msg.failure);
				return settleQueue([
					{
						...state,
						phase,
						interruption: interruptionAfter(state, phase),
						failure: msg.failure,
						sends: settlePending(state.sends, msg.failure),
					},
					noCmds,
				]);
			},
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
			"aiAgent.boot": noWork,
			"aiAgent.start": noWork,
			"aiAgent.prompt": noWork,
			"aiAgent.answer": noWork,
			"aiAgent.setMode": noWork,
			"aiAgent.setModel": noWork,
			"aiAgent.setThinkingLevel": noWork,
			"aiAgent.page": noWork,
			"aiAgent.interrupt": noWork,
			"aiAgent.reconnect": noWork,
			"aiAgent.republish": noWork,
		},
		subscribe: {"aiAgent.events": () => () => {}},
	});
};
