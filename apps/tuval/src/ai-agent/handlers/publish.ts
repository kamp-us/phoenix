/**
 * What the program writes out, and where.
 *
 * The three outbound projections are pure functions of the committed state, so nothing here keeps
 * a second copy of the transcript, the pending cards or the mode list: the core folded the event,
 * and this reads what the fold left. `ProcessSelf.state()` is `unknown` at the row (the registry
 * erases a program's private types), so the core's own predicate reads it back.
 *
 * `PortNotWired` is swallowed on purpose. A headless row is a founder ruling (#7557) and a
 * headless process has no route off `transcript`; refusing to publish to nobody would make every
 * event a handler failure. `PayloadRejected` is not swallowed — that is a graph whose route admits
 * a payload this program emits, which is a wiring bug and must be loud.
 */

import {Effect} from "effect";
import {PortNotWired, ProcessPorts} from "../../ports/index.ts";
import {ProcessSelf} from "../../process/self.ts";
import {type AiAgentSessionState, isAiAgentSessionState} from "../core/index.ts";
import type {ModePayload, PermissionPayload, TranscriptPayload} from "../ports/index.ts";

/**
 * The row's port keys. A two-way kind is played from both ends by one program, and a kernel `ports`
 * record holds one direction per key, so each end is named locally — `compile` matches the kind.
 */
export const aiAgentPortNames = {
	transcript: "transcript",
	pageRequest: "pageRequest",
	pageReply: "pageReply",
	prompt: "prompt",
	permissionPending: "permissionPending",
	permissionDecision: "permissionDecision",
	modeState: "modeState",
	modeSet: "modeSet",
} as const;

export const transcriptOf = (state: AiAgentSessionState): TranscriptPayload => state.transcript;

export const pendingOf = (state: AiAgentSessionState): PermissionPayload => ({
	kind: "pending",
	requests: state.permissions,
});

export const modeStateOf = (state: AiAgentSessionState): ModePayload => ({
	kind: "state",
	current: state.modes.current,
	available: state.modes.available,
});

/** This process's committed session state, or `null` when the reader refuses what it holds. */
export const readSession = Effect.map(ProcessSelf, (self) => {
	const raw = self.state();
	return isAiAgentSessionState(raw) ? raw : null;
});

export const emit = (port: string, payload: unknown) =>
	Effect.flatMap(ProcessPorts, (ports) => ports.emit(port, payload)).pipe(
		Effect.catchIf(
			(error): error is PortNotWired => error instanceof PortNotWired,
			() => Effect.void,
		),
		Effect.asVoid,
	);
