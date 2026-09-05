/**
 * The session's private vocabulary: the Msgs it accepts, the Cmds it emits and the one Sub it
 * subscribes to. All three are plain data — the work each Cmd names is an Effect handler on the
 * program row, never a value that travels inside the Cmd (#7371).
 *
 * `event` carries the session id it belongs to so the machine's `identity` filter drops a frame
 * from a session this instance has already replaced; every other Msg is identity-agnostic.
 */

import {type Sub, type SubId, subId} from "@demlik/tea";
import type {AgentEvent} from "../events.ts";
import type {Mode, PermissionDecision} from "../ports/index.ts";
import type {AgentFailure, HistoryPage} from "./state.ts";

export type AiAgentSessionMsg =
	| {readonly type: "start"; readonly cwd: string; readonly resume: string | null}
	| {readonly type: "started"; readonly sessionId: string}
	/**
	 * `key` is the idempotency key the window mints per deliberate send (ruling 2, #7570), and the
	 * id of the turn the `prompt` cell records is derived from it. `timestamp` rides along because
	 * that turn needs a clock and no update cell may read one (#7978).
	 */
	| {
			readonly type: "prompt";
			readonly text: string;
			readonly key: string;
			readonly timestamp: number;
	  }
	| {readonly type: "event"; readonly sessionId: string; readonly event: AgentEvent}
	/** `message` is the operator's optional note; the window offers one on every decision. */
	| {
			readonly type: "answer";
			readonly request: string;
			readonly decision: PermissionDecision;
			readonly message?: string;
	  }
	| {readonly type: "setMode"; readonly mode: Mode}
	| {readonly type: "page"; readonly before: string | null; readonly limit: number}
	| {readonly type: "paged"; readonly page: HistoryPage}
	| {readonly type: "interrupt"}
	| {readonly type: "reconnect"}
	| {readonly type: "failed"; readonly failure: AgentFailure};

export type AiAgentSessionCmd =
	/**
	 * Open this process's session, because the process is new. The one Cmd a fresh `init` emits.
	 *
	 * Its handler does no backend work: it answers with the `start` Msg and nothing else. `init`
	 * cannot dispatch a Msg — a Cmd is its only channel out — and the transition that opens a
	 * session belongs to the `start` cell, which is also the one guard against a second open. So
	 * this Cmd is the trampoline between them, and being trampoline-cheap is what keeps a spawn
	 * from blocking on the session: the real `aiAgent.start` runs on the process's own tail after
	 * the spawn has returned, rather than inside it.
	 */
	| {readonly type: "aiAgent.boot"; readonly cwd: string}
	| {readonly type: "aiAgent.start"; readonly cwd: string; readonly resume: string | null}
	| {readonly type: "aiAgent.prompt"; readonly text: string; readonly key: string}
	| {
			readonly type: "aiAgent.answer";
			readonly request: string;
			readonly decision: PermissionDecision;
			readonly message?: string;
	  }
	| {readonly type: "aiAgent.setMode"; readonly mode: Mode}
	| {readonly type: "aiAgent.page"; readonly before: string | null; readonly limit: number}
	| {readonly type: "aiAgent.interrupt"}
	| {readonly type: "aiAgent.reconnect"; readonly cwd: string; readonly sessionId: string}
	/**
	 * Publish the committed state's three outbound projections again, with no backend call.
	 *
	 * The outbound ports are event-driven — a projection leaves only when the fold moved it — so a
	 * window attached to a session that was restored from a checkpoint has nothing to render until
	 * the next event arrives. A restored session's pending permission cards are exactly the case
	 * that wedges: the cards are in state, the agent is still waiting on them, and no event is
	 * coming until one is answered (#7608).
	 */
	| {readonly type: "aiAgent.republish"};

/**
 * The one subscription: this session's event stream, keyed by the session *and* the connection.
 *
 * Demlik reconciles Subs by id — an id still desired keeps running, one that leaves is stopped, one
 * that appears is started. A reconnect rebuilds the layer under the same session id (ruling 4,
 * #7570), so an id made of the session alone reads as "already running" and leaves the process
 * subscribed to the transport it just tore down.
 */
export interface AiAgentEventsSub extends Sub<"aiAgent.events"> {
	readonly sessionId: string;
	readonly connection: number;
}

export type AiAgentSessionSub = AiAgentEventsSub;

export const eventsSubId = (sessionId: string, connection: number): SubId =>
	subId(`aiAgent.events:${sessionId}#${connection}`);

export const eventsSub = (sessionId: string, connection: number): AiAgentEventsSub => ({
	id: eventsSubId(sessionId, connection),
	type: "aiAgent.events",
	sessionId,
	connection,
});
