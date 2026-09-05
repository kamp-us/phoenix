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
 * Everything the composer asks for and this window does not have (models, thinking levels, project
 * trust, file completions) is answered empty rather than refused: an empty answer hides the control,
 * a rejection would put the composer in its `unavailable` state and disable the send button. The
 * mode switch and the permission cards are the next slice in this directory.
 *
 * Nothing here is React. It is a plain object with a setter, so its behaviour is unit-testable
 * without a DOM — which is what `composer-bridge.unit.test.ts` does.
 */

import type {AgentChatInputBridge, PiEvent} from "@kampus/design";
import type {Phase} from "../../ai-agent/events.ts";
import {isWorking} from "./phase.ts";

export interface ComposerHandlers {
	/** The operator submitted. The window mints the idempotency key, not this bridge. */
	readonly onPrompt: (text: string) => void;
	/** The operator asked to stop — the composer's stop button, or Escape while a turn is running. */
	readonly onInterrupt: () => void;
	readonly initialPhase: Phase;
}

export interface ComposerBridge {
	readonly bridge: AgentChatInputBridge;
	/**
	 * Tell a mounted composer where the session is now. Pushing an event rather than re-building the
	 * bridge is deliberate: `AgentChatInput` re-runs its whole load on a new bridge identity, so a
	 * bridge rebuilt per phase would re-enter `loading` on every turn.
	 */
	readonly setPhase: (phase: Phase) => void;
}

const none =
	<A>(value: A) =>
	(): Promise<A> =>
		Promise.resolve(value);

export const composerBridge = (handlers: ComposerHandlers): ComposerBridge => {
	let phase = handlers.initialPhase;
	let listener: ((event: PiEvent) => void) | null = null;

	const bridge: AgentChatInputBridge = {
		loadPiState: () => Promise.resolve({isStreaming: isWorking(phase)}),
		loadPiCommands: none([]),
		loadPiModels: none([]),
		loadPiThinkingLevels: none([]),
		loadPiFiles: none([]),
		setPiModel: none(undefined),
		setPiThinkingLevel: none(undefined),
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
	};
};
