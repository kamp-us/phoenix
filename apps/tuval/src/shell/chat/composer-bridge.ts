/**
 * The composer's seam onto the window, and the whole reason `ChatWindow` can reuse `AgentChatInput`
 * unchanged.
 *
 * `AgentChatInput` (`@kampus/design`) does not take an `onSubmit`: it sends through an
 * `AgentChatInputBridge` and reads a live connection state off that bridge's event subscription.
 * So the bridge *is* the seam. This one answers out of the window's own vocabulary — a submit
 * becomes a `prompt` Msg, a stop becomes an `interrupt` Msg, and the session's phase is pushed as
 * the two events the composer keys its working/ready state on.
 *
 * Project trust and file completions are capabilities this window does not have, and both are
 * answered empty rather than refused: a rejection would put the composer in its `unavailable` state
 * and disable the send button. An empty answer is not a hidden control, though — the composer
 * renders each picker whatever its list holds, so a control with nothing behind it reads as broken
 * rather than absent (#8062), which is why the two settings this window *does* have are wired
 * rather than stubbed.
 *
 * Models (#7981) and thinking levels (#8062) are those two. Both read the session's own state —
 * `AiAgentSessionState.models` and `.thinking`, fed by each layer's `model` and `thinking` events —
 * and a pick becomes a `setModel` or `setThinkingLevel` Msg. Neither list is known at mount,
 * because the agent has not started when the composer runs its loads, so both are *pushed* through
 * the same subscription the phase is: `AgentChatInput` re-runs its whole load on a new bridge
 * identity, and rebuilding the bridge per state change would drop the composer back to `loading` on
 * every turn.
 *
 * Nothing here is React. It is a plain object with a setter, so its behaviour is unit-testable
 * without a DOM — which is what `composer-bridge.unit.test.ts` does.
 */

import type {AgentChatInputBridge, PiEvent, PiModel, PiThinkingLevel} from "@kampus/design";
import type {ModelState, ThinkingState} from "../../ai-agent/core/index.ts";
import type {Phase} from "../../ai-agent/events.ts";
import type {ModelRef, ThinkingLevel} from "../../ai-agent/ports/index.ts";
import {isWorking} from "./phase.ts";

export interface ComposerHandlers {
	/** The operator submitted. The window mints the idempotency key, not this bridge. */
	readonly onPrompt: (text: string) => void;
	/** The operator asked to stop — the composer's stop button, or Escape while a turn is running. */
	readonly onInterrupt: () => void;
	/** The operator picked a model. The window turns it into the `setModel` Msg. */
	readonly onSetModel: (model: ModelRef) => void;
	/** The operator picked a thinking level, turned into the `setThinkingLevel` Msg. */
	readonly onSetThinkingLevel: (level: ThinkingLevel) => void;
	readonly initialPhase: Phase;
	readonly initialModels: ModelState;
	readonly initialThinking: ThinkingState;
}

/**
 * The composer names a model by `provider/id` and labels it by `name`, so a ref with no provider
 * gets one that cannot collide with a real provider's namespace — a bare id would make two
 * backends' same-named models one row.
 */
const composerModel = (model: ModelRef): PiModel => ({
	provider: model.provider ?? "agent",
	id: model.id,
	name: model.name,
});

const refOf = (model: PiModel, offered: ReadonlyArray<ModelRef>): ModelRef | null =>
	offered.find(
		(candidate) =>
			composerModel(candidate).provider === model.provider && candidate.id === model.id,
	) ?? null;

/**
 * The offered level as this interface names it. The design vocabulary and this one are the same
 * seven strings, so the lookup is the whole crossing — and it is a `find` rather than an
 * `includes`, so what comes back is typed by the session's own list and needs no cast.
 */
const levelOf = (
	level: PiThinkingLevel,
	offered: ReadonlyArray<ThinkingLevel>,
): ThinkingLevel | null => offered.find((candidate) => candidate === level) ?? null;

/** The one event the composer takes its catalogs on: its `harness_status` arm. */
const status = (models: ModelState, thinking: ThinkingState): PiEvent => ({
	type: "harness_status",
	status: {
		models: models.available.map(composerModel),
		...(models.current === null ? {} : {model: composerModel(models.current)}),
		thinkingLevels: thinking.available,
		...(thinking.current === null ? {} : {thinkingLevel: thinking.current}),
	},
});

export interface ComposerBridge {
	readonly bridge: AgentChatInputBridge;
	/**
	 * Tell a mounted composer where the session is now. Pushing an event rather than re-building the
	 * bridge is deliberate: `AgentChatInput` re-runs its whole load on a new bridge identity, so a
	 * bridge rebuilt per phase would re-enter `loading` on every turn.
	 */
	readonly setPhase: (phase: Phase) => void;
	/**
	 * Tell a mounted composer what the session now offers and runs on. Neither catalog is known at
	 * mount — the agent has not started — so this is the only way they reach the pickers.
	 */
	readonly setCatalogs: (models: ModelState, thinking: ThinkingState) => void;
}

const none =
	<A>(value: A) =>
	(): Promise<A> =>
		Promise.resolve(value);

export const composerBridge = (handlers: ComposerHandlers): ComposerBridge => {
	let phase = handlers.initialPhase;
	let models = handlers.initialModels;
	let thinking = handlers.initialThinking;
	let listener: ((event: PiEvent) => void) | null = null;

	const bridge: AgentChatInputBridge = {
		loadPiState: () =>
			Promise.resolve({
				isStreaming: isWorking(phase),
				...(models.current === null ? {} : {model: composerModel(models.current)}),
				...(thinking.current === null ? {} : {thinkingLevel: thinking.current}),
			}),
		loadPiCommands: none([]),
		loadPiModels: () => Promise.resolve(models.available.map(composerModel)),
		loadPiThinkingLevels: () => Promise.resolve(thinking.available),
		loadPiFiles: none([]),
		// A pick the session does not offer is dropped rather than rejected: the bridge's contract is
		// that nothing here rejects, and the core would refuse the Msg anyway.
		setPiModel: (model) => {
			const picked = refOf(model, models.available);
			if (picked !== null) handlers.onSetModel(picked);
			return Promise.resolve();
		},
		setPiThinkingLevel: (level) => {
			const picked = levelOf(level, thinking.available);
			if (picked !== null) handlers.onSetThinkingLevel(picked);
			return Promise.resolve();
		},
		setPiProjectTrust: none(undefined),
		sendPiPrompt: ({message}) => {
			handlers.onPrompt(message);
			return Promise.resolve();
		},
		abortPi: () => {
			handlers.onInterrupt();
			return Promise.resolve();
		},
		answerPiExtension: none(undefined),
		subscribeToPiEvents: (onEvent) => {
			listener = onEvent;
			// The composer subscribes *after* its four loads resolve, so a catalog that landed in
			// between was pushed at a listener that did not exist yet and would be lost until the
			// next event — which, on a session nobody switches, never comes.
			if (models.available.length > 0 || thinking.available.length > 0) {
				onEvent(status(models, thinking));
			}
			return () => {
				if (listener === onEvent) listener = null;
			};
		},
	};

	return {
		bridge,
		setPhase: (next) => {
			const was = isWorking(phase);
			phase = next;
			const now = isWorking(next);
			if (was === now) return;
			listener?.({type: now ? "agent_start" : "agent_settled"});
		},
		setCatalogs: (nextModels, nextThinking) => {
			models = nextModels;
			thinking = nextThinking;
			listener?.(status(nextModels, nextThinking));
		},
	};
};
