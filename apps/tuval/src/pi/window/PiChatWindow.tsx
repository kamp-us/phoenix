/**
 * `PiChatWindow` — what the `pi-session` row renders: the shared `ChatWindow`, and nothing added on
 * top.
 *
 * It used to supply one extra line to the chat bar — the model, cost and token counts. The founder's
 * 2026-09-05 ruling (#8190) sent those facts to the desk inspector, so the bar carries the phase
 * line alone and both backends' bars read identically. The inspector is
 * `../../ai-agent/window/AiAgentInspector.tsx`, declared as this row's `inspector` reference in
 * `../program.ts`, and it is shared rather than per-backend because every value in it is read off
 * `AiAgentSessionState` — which is also what closes the duplicated usage line of #7956.
 *
 * The file stays rather than collapsing into a re-export of `chatWindow()`: `PI_CHAT_WINDOW_REF` is
 * the name the row declares, and a page's table binds a renderer by that name.
 */

import type {ChatWindowRenderer, ThinChatWindowOptions} from "../../shell/chat/index.ts";
import {chatWindow} from "../../shell/chat/index.ts";

/**
 * The Pi renderer at whatever window options a caller needs — every option but `extras`, which
 * `ThinChatWindowOptions` withholds because the binding owns that slot.
 */
export const piChatWindow = (options: ThinChatWindowOptions = {}): ChatWindowRenderer =>
	chatWindow(options);

/**
 * The renderer `PI_CHAT_WINDOW_REF` names, at its defaults — every feature flag off. The page's
 * table no longer binds it: that table builds its own at the operator's flags (#8439). This stays as
 * the defaults themselves, which is what a test mounting the window without options wants.
 */
export const PiChatWindow: ChatWindowRenderer = piChatWindow();
