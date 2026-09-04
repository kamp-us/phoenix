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
	/** `key` is the idempotency key the window mints per deliberate send (ruling 2, #7570). */
	| {readonly type: "prompt"; readonly text: string; readonly key: string}
	| {readonly type: "event"; readonly sessionId: string; readonly event: AgentEvent}
	| {readonly type: "answer"; readonly request: string; readonly decision: PermissionDecision}
	| {readonly type: "setMode"; readonly mode: Mode}
	| {readonly type: "page"; readonly before: string | null; readonly limit: number}
	| {readonly type: "paged"; readonly page: HistoryPage}
	| {readonly type: "interrupt"}
	| {readonly type: "reconnect"}
	| {readonly type: "failed"; readonly failure: AgentFailure};

export type AiAgentSessionCmd =
	| {readonly type: "aiAgent.start"; readonly cwd: string; readonly resume: string | null}
	| {readonly type: "aiAgent.prompt"; readonly text: string; readonly key: string}
	| {
			readonly type: "aiAgent.answer";
			readonly request: string;
			readonly decision: PermissionDecision;
	  }
	| {readonly type: "aiAgent.setMode"; readonly mode: Mode}
	| {readonly type: "aiAgent.page"; readonly before: string | null; readonly limit: number}
	| {readonly type: "aiAgent.interrupt"}
	| {readonly type: "aiAgent.reconnect"; readonly cwd: string; readonly sessionId: string};

/** The one subscription: this session's event stream, keyed by the session it belongs to. */
export interface AiAgentEventsSub extends Sub<"aiAgent.events"> {
	readonly sessionId: string;
}

export type AiAgentSessionSub = AiAgentEventsSub;

export const eventsSubId = (sessionId: string): SubId => subId(`aiAgent.events:${sessionId}`);

export const eventsSub = (sessionId: string): AiAgentEventsSub => ({
	id: eventsSubId(sessionId),
	type: "aiAgent.events",
	sessionId,
});
