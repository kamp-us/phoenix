/**
 * `ClaudeChatWindow` — what the `claude-session` row renders: the shared `ChatWindow`, and nothing
 * added on top.
 *
 * It used to supply two extra lines to the chat bar — the model, cost and token counts, then the
 * session id and the working directory. The founder's 2026-09-05 ruling (#8190) sent all five facts
 * to the desk inspector, so the bar carries the phase line alone and both backends' bars read
 * identically. The inspector is `../../ai-agent/window/AiAgentInspector.tsx`, declared as this row's
 * `inspector` reference in `../program.ts`, and it is shared rather than per-backend because every
 * value in it is read off `AiAgentSessionState`.
 *
 * The file stays rather than collapsing into a re-export of `chatWindow()`: `CLAUDE_CHAT_WINDOW_REF`
 * is the name the row declares, and a page's table binds a renderer by that name. What the Claude
 * binding adds is nothing today, which is the ruling's point.
 */

import type {ChatWindowOptions, ChatWindowRenderer} from "../../shell/chat/index.ts";
import {chatWindow} from "../../shell/chat/index.ts";

/** The Claude renderer at whatever window options a caller needs. */
export const claudeChatWindow = (options: ChatWindowOptions = {}): ChatWindowRenderer =>
	chatWindow(options);

/**
 * The renderer `CLAUDE_CHAT_WINDOW_REF` names, at its defaults — every feature flag off. The page's
 * table no longer binds it: that table builds its own at the operator's flags (#8439). This stays as
 * the defaults themselves, which is what a test mounting the window without options wants.
 */
export const ClaudeChatWindow: ChatWindowRenderer = claudeChatWindow();
