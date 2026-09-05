/**
 * The Claude window as a page's renderer table imports it. Importing this pulls React, the shared
 * chat window and `@kampus/design` — and nothing of Claude's own: no Agent SDK, no `../agent/`, no
 * `../tools/`, no `../../ai-agent/service/`. `boundary.unit.test.ts` holds that.
 *
 * The name the row declares lives one directory up (`../renderer-ref.ts`) and is re-exported here,
 * so a page's renderer table reads the reference and the renderer from one import while the
 * kernel-side row still reaches none of the above.
 */

export {CLAUDE_CHAT_WINDOW_REF} from "../renderer-ref.ts";
export {ClaudeChatWindow, claudeChatWindow, SessionLine, UsageLine} from "./ClaudeChatWindow.tsx";
