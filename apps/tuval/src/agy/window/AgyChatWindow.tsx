/**
 * `AgyChatWindow` — what the `agy-session` row renders: the shared `ChatWindow` plus agy's one
 * extra.
 *
 * Shaped on `../../pi/window/PiChatWindow.tsx`, which is epic #8162's scope call: agy follows
 * `src/pi/` and not `src/claude/`. Nothing here re-derives a transcript, a composer or a control —
 * the window is `../../shell/chat/`'s, and this module supplies its `extras` slot with a usage line
 * read straight off the session state.
 *
 * Two things are deliberate and not obvious.
 *
 * **The line reads state, it does not accumulate.** `usage` is the core's own per-turn ledger
 * (`../../ai-agent/core/state.ts`) summed by its own `usageTotals`, checkpointed with the rest of
 * the session, so two windows over one process show one figure and a restart shows the figure it
 * left on. There is no counter here, and this file never sees an agy wire event: what fills the
 * ledger is the mapper's business.
 *
 * **It is not a live region.** Cost and token counts move on every usage event of a running turn,
 * and a `role="status"` here would narrate the whole turn to a screen-reader user. It is a named
 * `group` of plain text instead: reachable on demand, silent while it changes.
 */

import {MetaRow} from "@kampus/design";
import type {ReactElement} from "react";
import {type UsageTotals, usageTotals} from "../../ai-agent/core/index.ts";
import type {ChatWindowOptions, ChatWindowRenderer} from "../../shell/chat/index.ts";
import {chatWindow} from "../../shell/chat/index.ts";
import "./agy-window.css";

/**
 * `UsageTotals.cost` is a currency amount by the field's own contract — whoever fills it does the
 * scaling, as Pi's adapter does. Four fraction digits for Pi's reason: a single turn routinely costs
 * well under a cent, and a session that reads `$0.00` after ten turns says nothing.
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

/**
 * The model, the cumulative cost and the token counts of this session.
 *
 * Every number carries visible text beside it, because a bare number names nothing to a screen
 * reader (`.patterns/manti-accessibility.md`); the group's own label is what a reader jumps to.
 */
export function UsageLine({usage}: {readonly usage: UsageTotals}): ReactElement {
	return (
		<MetaRow className="tuval-agy-usage" role="group" aria-label="Session usage">
			<span className="tuval-agy-usage-model">{usage.model ?? NO_MODEL_YET}</span>
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
 * The agy renderer at whatever window options a caller needs. `extras` is fixed rather than merged:
 * it is the one thing this binding exists to add, and a caller overriding it would be asking for
 * the shared window under agy's name.
 */
export const agyChatWindow = (options: ChatWindowOptions = {}): ChatWindowRenderer =>
	chatWindow({...options, extras: (state) => <UsageLine usage={usageTotals(state.usage)} />});

/** The renderer `AGY_CHAT_WINDOW_REF` names, at its defaults: what a page's renderer table binds. */
export const AgyChatWindow: ChatWindowRenderer = agyChatWindow();
