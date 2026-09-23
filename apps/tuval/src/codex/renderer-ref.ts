import type {RendererRef} from "@kampus/tuval/kernel/registry/program";

export const CODEX_SESSION_PROGRAM = "codex-session";
export const CODEX_CHAT_WINDOW_REF: RendererRef = {
	kind: "host-native",
	ref: "tuval/codex-chat-window",
};
