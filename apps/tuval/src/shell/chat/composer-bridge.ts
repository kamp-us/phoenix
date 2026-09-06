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
 * Everything the composer asks for and this window does not have (thinking levels, project trust,
 * file completions) — and a backend that offers no commands — is answered empty rather than
 * refused: an empty answer hides the control, a rejection would put the composer in its
 * `unavailable` state and disable the send button.
 *
 * Models (#7981) and slash commands (#8060) are the two capabilities this window does have. Both
 * lists are the session's own — `AiAgentSessionState.models` and `.commands`, fed by each layer's
 * `model` and `commands` events — and a model pick becomes a `setModel` Msg while a command pick
 * is just text the composer writes into the draft. Both arrive after mount, because the agent has
 * not started when the composer runs its loads, so they are *pushed* through the same subscription
 * the phase is: `AgentChatInput` re-runs its whole load on a new bridge identity, and rebuilding
 * the bridge per state change would drop the composer back to `loading` on every turn.
 *
 * Nothing here is React. It is a plain object with a setter, so its behaviour is unit-testable
 * without a DOM — which is what `composer-bridge.unit.test.ts` does.
 */

import type {AgentChatInputBridge, PiCommand, PiEvent, PiModel} from "@kampus/design";
import type {ModelState} from "../../ai-agent/core/index.ts";
import type {Phase} from "../../ai-agent/events.ts";
import type {CommandRef, ModelRef} from "../../ai-agent/ports/index.ts";
import {isWorking} from "./phase.ts";

export interface ComposerHandlers {
	/** The operator submitted. The window mints the idempotency key, not this bridge. */
	readonly onPrompt: (text: string) => void;
	/** The operator asked to stop — the composer's stop button, or Escape while a turn is running. */
	readonly onInterrupt: () => void;
	/** The operator picked a model. The window turns it into the `setModel` Msg. */
	readonly onSetModel: (model: ModelRef) => void;
	readonly initialPhase: Phase;
	readonly initialModels: ModelState;
	readonly initialCommands: ReadonlyArray<CommandRef>;
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
 * The composer's command rows. `argumentHint` is dropped rather than folded into the description:
 * the picker inserts the command and the operator types the arguments, so a hint rendered as prose
 * would read as part of what the command does.
 */
const composerCommand = (command: CommandRef): PiCommand => ({
	name: command.name,
	...(command.description === undefined ? {} : {description: command.description}),
});

/** The one event the composer takes a catalog on: its `harness_status` arm. */
const catalogStatus = (models: ModelState, commands: ReadonlyArray<CommandRef>): PiEvent => ({
	type: "harness_status",
	status: {
		models: models.available.map(composerModel),
		commands: commands.map(composerCommand),
		...(models.current === null ? {} : {model: composerModel(models.current)}),
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
	 * Tell a mounted composer what the session now offers and runs on. The catalog is not known at
	 * mount — the agent has not started — so this is the only way it reaches the picker.
	 */
	readonly setModels: (models: ModelState) => void;
	/** Same push, same reason: the slash catalog is not known until the session opens. */
	readonly setCommands: (commands: ReadonlyArray<CommandRef>) => void;
}

const none =
	<A>(value: A) =>
	(): Promise<A> =>
		Promise.resolve(value);

export const composerBridge = (handlers: ComposerHandlers): ComposerBridge => {
	let phase = handlers.initialPhase;
	let models = handlers.initialModels;
	let commands = handlers.initialCommands;
	let listener: ((event: PiEvent) => void) | null = null;

	const bridge: AgentChatInputBridge = {
		loadPiState: () =>
			Promise.resolve({
				isStreaming: isWorking(phase),
				...(models.current === null ? {} : {model: composerModel(models.current)}),
			}),
		loadPiCommands: () => Promise.resolve(commands.map(composerCommand)),
		loadPiModels: () => Promise.resolve(models.available.map(composerModel)),
		loadPiThinkingLevels: none([]),
		loadPiFiles: none([]),
		// A pick the session does not offer is dropped rather than rejected: the bridge's contract is
		// that nothing here rejects, and the core would refuse the Msg anyway.
		setPiModel: (model) => {
			const picked = refOf(model, models.available);
			if (picked !== null) handlers.onSetModel(picked);
			return Promise.resolve();
		},
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
			// The composer subscribes *after* its four loads resolve, so a catalog that landed in
			// between was pushed at a listener that did not exist yet and would be lost until the
			// next catalog event — which, on a session nobody switches, never comes.
			if (models.available.length > 0 || commands.length > 0) {
				onEvent(catalogStatus(models, commands));
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
		setModels: (next) => {
			models = next;
			listener?.(catalogStatus(next, commands));
		},
		setCommands: (next) => {
			commands = next;
			listener?.(catalogStatus(models, next));
		},
	};
};
