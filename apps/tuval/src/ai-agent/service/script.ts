/**
 * The data `ScriptedAiAgent.layer` replays: what a session already holds, what it offers, and what
 * each prompt answers with.
 *
 * A script is plain data with no Effect in it, so a fixture is readable as a transcript of the
 * conversation it stands for and a test asserts against the very array it handed the layer.
 */

import type {Mode, TranscriptItem} from "../ports/index.ts";
import type {TransportError} from "./errors.ts";
import type {AgentEvent} from "./events.ts";

/** One prompt's answer: the events it emits, in order, and whether the transport dies after them. */
export interface ScriptedTurn {
	readonly events: ReadonlyArray<AgentEvent>;
	/**
	 * When set, the stream fails with this error once the turn's events are out, and the session
	 * stays down: nothing reconnects on its own, so a later call fails rather than quietly working.
	 */
	readonly disconnect?: TransportError;
}

export interface ScriptedModes {
	readonly current: Mode | null;
	readonly available: ReadonlyArray<Mode>;
}

export interface AgentScript {
	readonly sessionId: string;
	/**
	 * What an earlier run of this session left behind, oldest first. `start({resume})` replays it
	 * and `page` serves it — the two halves of "history is backend-owned" (ruling 5, #7569).
	 */
	readonly history: ReadonlyArray<TranscriptItem>;
	readonly modes: ScriptedModes;
	/** One entry per prompt, consumed in order. */
	readonly turns: ReadonlyArray<ScriptedTurn>;
	/** What `interrupt` emits — normally the cut-short assistant item carrying `interrupted`. */
	readonly interrupt: ReadonlyArray<AgentEvent>;
}
