import type {RendererRef} from "../registry/program.ts";

export const CODEX_SESSION_PROGRAM = "codex-session";
export const CODEX_CHAT_WINDOW_REF: RendererRef = {
	kind: "host-native",
	ref: "tuval/codex-chat-window",
};
