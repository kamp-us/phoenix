import {chatWindow} from "../../shell/chat/index.ts";

export {CODEX_CHAT_WINDOW_REF} from "../renderer-ref.ts";
export const codexChatWindow = chatWindow;
export const CodexChatWindow = codexChatWindow();
