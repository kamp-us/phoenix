/**
 * `ClaudeChatWindow` — what the `claude-session` row renders: the shared `ChatWindow` plus Claude's
 * two extra lines.
 *
 * The whole file is the founder's "the Pi and Claude renderers are thin bindings that add only
 * their extras" (2026-09-02, amended on #7572 / #7584). The transcript, the paging, the composer,
 * the phase line, the resend, the tool rows, the permission cards and the mode switch are all
 * `../../shell/chat/`'s; this module supplies its `extras` slot and nothing more. Everything below
 * is read off the generic session state — renderer = f(state, view) — so no SDK type, no
 * subprocess and no permission or mode logic of Claude's own appears here.
 *
 * Three things are deliberate and not obvious.
 *
 * **The lines read state, they do not accumulate.** `usage` is the core's own running total
 * (`../../ai-agent/core/state.ts`), checkpointed with the rest of the session, so two windows over
 * one process show one figure and a restart shows the figure it left on. There is no counter here.
 *
 * **Neither line is a live region.** Cost and token counts move on every usage event of a running
 * turn, and a `role="status"` here would narrate the whole turn to a screen-reader user. Both are
 * named `group`s of plain text instead: reachable on demand, silent while they change.
 *
 * **The session line names no CLI version, because the state carries none.** `#7580`'s ruling put
 * the SDK/CLI pair in a log line, and that is the only place `claude_code_version` goes: the `init`
 * mapping emits a phase and a usage event (`../history/map.ts`), and `AiAgentSessionState` has no
 * version field. A renderer's input is the state, so this line shows what the state has —
 * [#7955](https://github.com/kamp-us/phoenix/issues/7955) is the plumbing that would give it the
 * third value.
 *
 * The usage line is Pi's, written a second time rather than shared: importing
 * `../../pi/window/` would make the Claude program depend on the Pi program, which both windows'
 * boundary tests exist to refuse, and the shared home for it does not exist yet
 * ([#7956](https://github.com/kamp-us/phoenix/issues/7956)).
 */

import {MetaRow} from "@kampus/design";
import type {ReactElement} from "react";
import type {AiAgentSessionState, UsageTotals} from "../../ai-agent/core/index.ts";
import type {ChatWindowOptions, ChatWindowRenderer} from "../../shell/chat/index.ts";
import {chatWindow} from "../../shell/chat/index.ts";
import "./claude-window.css";

/**
 * The SDK reports `total_cost_usd` already in dollars and the mapping passes it through unscaled
 * (`../history/map.ts`), so `UsageTotals.cost` is a currency amount and needs no conversion here.
 * Four fraction digits because a single turn routinely costs well under a cent, and a session that
 * reads `$0.00` after ten turns says nothing.
 */
const money = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 4,
});

const tokens = new Intl.NumberFormat("en-US");

/** Before the first usage event the session has no model to name, and says so rather than blanking. */
const NO_MODEL_YET = "no model yet";

/** Before `start` answers there is no session id, and an empty slot would read as a lost one. */
const NO_SESSION_YET = "no session yet";

/**
 * The model, the cumulative cost and the token counts of this session.
 *
 * Every number carries visible text beside it, because a bare number names nothing to a screen
 * reader (`.patterns/manti-accessibility.md`); the group's own label is what a reader jumps to.
 */
export function UsageLine({usage}: {readonly usage: UsageTotals}): ReactElement {
	return (
		<MetaRow className="tuval-claude-usage" role="group" aria-label="Session usage">
			<span className="tuval-claude-usage-model">{usage.model ?? NO_MODEL_YET}</span>
			<MetaRow.Dot />
			<span>{money.format(usage.cost)}</span>
			<MetaRow.Dot />
			<span>{tokens.format(usage.inputTokens)} in</span>
			<MetaRow.Dot />
			<span>{tokens.format(usage.outputTokens)} out</span>
		</MetaRow>
	);
}

/**
 * Which session this window is looking at, and where it is running.
 *
 * The id is prefixed because a bare opaque id names nothing to a reader the way a path does — the
 * same rule that puts "in" and "out" beside the token counts above.
 */
export function SessionLine({
	sessionId,
	cwd,
}: {
	readonly sessionId: string | null;
	readonly cwd: string;
}): ReactElement {
	return (
		<MetaRow className="tuval-claude-session" role="group" aria-label="Session details">
			<span className="tuval-claude-session-id">session {sessionId ?? NO_SESSION_YET}</span>
			<MetaRow.Dot />
			<span className="tuval-claude-session-cwd">{cwd}</span>
		</MetaRow>
	);
}

/** Claude's whole contribution to the chat bar: two stacked lines of plain text. */
function ClaudeExtras({state}: {readonly state: AiAgentSessionState}): ReactElement {
	return (
		<div className="tuval-claude-extras">
			<UsageLine usage={state.usage} />
			<SessionLine sessionId={state.sessionId} cwd={state.cwd} />
		</div>
	);
}

/**
 * The Claude renderer at whatever window options a caller needs. `extras` is fixed rather than
 * merged: it is the one thing this binding exists to add, and a caller overriding it would be
 * asking for the shared window under Claude's name.
 */
export const claudeChatWindow = (options: ChatWindowOptions = {}): ChatWindowRenderer =>
	chatWindow({...options, extras: (state) => <ClaudeExtras state={state} />});

/** The renderer `CLAUDE_CHAT_WINDOW_REF` names, at its defaults: what a page's table binds. */
export const ClaudeChatWindow: ChatWindowRenderer = claudeChatWindow();
