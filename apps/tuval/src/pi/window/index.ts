/**
 * The Pi window as a page's renderer table imports it. Importing this pulls React, the shared chat
 * window and `@kampus/design` — and nothing of Pi's wire: no socket, no `../server/`, no
 * `../client/`, no `../ai-agent/`. `boundary.unit.test.ts` holds that.
 *
 * The name the row declares lives one directory up (`../renderer-ref.ts`) and is re-exported here,
 * so a page's renderer table reads the reference and the renderer from one import while the
 * kernel-side row still reaches none of the above.
 */

export {PI_CHAT_WINDOW_REF} from "../renderer-ref.ts";
export {PiChatWindow, piChatWindow, UsageLine} from "./PiChatWindow.tsx";
