/**
 * The data `ScriptedAiAgent.layer` replays: what a session already holds, what it offers, and what
 * each prompt answers with.
 *
 * A script is plain data with no Effect in it, so a fixture is readable as a transcript of the
 * conversation it stands for and a test asserts against the very array it handed the layer. The
 * one exception is `spells`: a script whose turns call the kernel has to be handed the kernel, and
 * that reach is a service value, not a literal.
 */

import type {SpellBridgeApi} from "../../commands/bridge/index.ts";
import type {SpellPath, Scope as SpellScope} from "../../commands/spell.ts";
import type {AgentEvent} from "../events.ts";
import type {Mode, TranscriptItem} from "../ports/index.ts";
import type {TransportError} from "./errors.ts";

/** One spell a turn calls: the path and the args, exactly as they cross the wire. */
export interface ScriptedRequest {
	readonly path: SpellPath;
	readonly args: unknown;
}

/** What one such call answered: the request it belongs to, and the reply's own outcome. */
export interface ScriptedAnswer {
	readonly request: ScriptedRequest;
	readonly ok: boolean;
	/** The reply's result when `ok`, and the failure it carried otherwise. */
	readonly answer: unknown;
}

/**
 * The next spell a turn calls, given every answer it has already had; `null` ends the turn.
 *
 * A step rather than a list, because an agent picks its second call out of its first one's reply:
 * a fixture that had to name every call up front could not enumerate a registry it has not read
 * yet. It is a pure function, so a script stays something a test can read and re-run.
 */
export type ScriptedPlan = (answered: ReadonlyArray<ScriptedAnswer>) => ScriptedRequest | null;

/** What a script's calls reach, and the scope each one carries. */
export interface ScriptedSpells {
	readonly bridge: SpellBridgeApi;
	readonly scope: SpellScope;
}

/** One prompt's answer: the events it emits, in order, and whether the transport dies after them. */
export interface ScriptedTurn {
	readonly events: ReadonlyArray<AgentEvent>;
	/**
	 * The spells this turn calls, after its `events` are out. Each call becomes one `tool` item on
	 * the transcript, so the session records what it asked and what came back.
	 */
	readonly plan?: ScriptedPlan;
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
	/**
	 * What this session's turns call, and from where. A script whose turns carry no `plan` needs
	 * none; a turn that plans a call while this is absent is a fixture bug the layer dies on.
	 */
	readonly spells?: ScriptedSpells;
	/** What `interrupt` emits — normally the cut-short assistant item carrying `interrupted`. */
	readonly interrupt: ReadonlyArray<AgentEvent>;
}
