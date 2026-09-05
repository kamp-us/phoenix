/**
 * `PiChatWindow` — what the `pi-session` row renders: the shared `ChatWindow` plus Pi's one extra.
 *
 * The whole file is the founder's "the Pi and Claude renderers are thin bindings that add only
 * their extras" (2026-09-02, amended on #7572 / #7584). Nothing here re-derives a transcript, a
 * composer or a control: the window is `../../shell/chat/`'s, and this module supplies its `extras`
 * slot with a usage line read straight off the session state — renderer = f(state, view).
 *
 * Two things are deliberate and not obvious.
 *
 * **The line reads state, it does not accumulate.** `usage` is the core's own running total
 * (`../../ai-agent/core/state.ts`), checkpointed with the rest of the session, so two windows over
 * one process show one figure and a restart shows the figure it left on. There is no counter here.
 *
 * **It is not a live region.** Cost and token counts move on every usage event of a running turn,
 * and a `role="status"` here would narrate the whole turn to a screen-reader user. It is a named
 * `group` of plain text instead: reachable on demand, silent while it changes.
 *
 * The surface re-derived is the spike gist's `play.html` (#7469, founder gist) — its header strip
 * carried the model, the running cost and the token counts of the open Luna session in one muted
 * line. Nothing is imported from it or from the `epic/7140` POC branch; the markup below is the
 * `@kampus/design` `MetaRow` primitive, which the POC page predates.
 */

import {MetaRow} from "@kampus/design";
import type {ReactElement} from "react";
import type {UsageTotals} from "../../ai-agent/core/index.ts";
import type {ChatWindowOptions, ChatWindowRenderer} from "../../shell/chat/index.ts";
import {chatWindow} from "../../shell/chat/index.ts";
import "./pi-window.css";

/**
 * Pi prices its models per million tokens and divides at the adapter (`@earendil-works/pi-ai`
 * `dist/models.js:540-543`: `usage.cost.input = (rates.input / 1000000) * usage.input`), so
 * `UsageTotals.cost` is already a currency amount and needs no scaling here. Four fraction digits
 * because a single turn routinely costs well under a cent, and a session that reads `$0.00` after
 * ten turns says nothing.
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
		<MetaRow className="tuval-pi-usage" role="group" aria-label="Session usage">
			<span className="tuval-pi-usage-model">{usage.model ?? NO_MODEL_YET}</span>
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
 * The Pi renderer at whatever window options a caller needs. `extras` is fixed rather than merged:
 * it is the one thing this binding exists to add, and a caller overriding it would be asking for
 * the shared window under Pi's name.
 */
export const piChatWindow = (options: ChatWindowOptions = {}): ChatWindowRenderer =>
	chatWindow({...options, extras: (state) => <UsageLine usage={state.usage} />});

/** The renderer `PI_CHAT_WINDOW_REF` names, at its defaults: what a page's renderer table binds. */
export const PiChatWindow: ChatWindowRenderer = piChatWindow();
