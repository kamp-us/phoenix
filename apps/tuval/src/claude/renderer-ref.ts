/**
 * The `claude-session` row's two names — its program id and its renderer reference — as a leaf both
 * ends can import.
 *
 * Same split as `../pi/renderer-ref.ts`, for the same reason: the row is kernel-side and reaches the
 * Agent SDK, the renderer is browser-side and must reach neither, so the two names they share live
 * alone in a file that imports one type. The window itself is #7624's; this file is what it binds to.
 */

import type {RendererRef} from "../registry/program.ts";

export const CLAUDE_SESSION_PROGRAM = "claude-session";

export const CLAUDE_CHAT_WINDOW_REF: RendererRef = {
	kind: "host-native",
	ref: "tuval/claude-chat-window",
};
