/**
 * The `pi-session` row's two names — its program id and its renderer reference — as a leaf both
 * ends can import.
 *
 * The row is kernel-side and must stay free of React (`../page/renderers.tsx` says why the page's
 * table is keyed by program id); the renderer is browser-side and must reach no Pi transport. So the
 * one value they share — the name — lives here, alone, importing nothing but a type. Written twice
 * instead, the row and the table would drift silently: an unresolved reference is a returned value,
 * not a throw (`../shell/window/renderer.ts`), so the window would simply come up blank.
 *
 * It sits beside the row rather than inside `./window/`, because the strict lens is `composite` and
 * must list every file it compiles: `./window/` is excluded from it whole (it imports
 * `@kampus/design`, which needs the relaxed lens of `tsconfig.design.json`), and a file the row
 * imports out of an excluded directory is a `TS6307` on every build.
 */

import type {RendererRef} from "../registry/program.ts";

/**
 * The row's program id. The page's renderer table is keyed by program id
 * (`../page/renderers.tsx` says why), so the page needs this string; importing it from
 * `./program.ts` would pull `node:path`, Pi's model runtime and the whole kernel-side row into the
 * browser bundle, which is the failure #7836 closed. `./program.ts` re-exports it, so there is one
 * declaration and the row and the table cannot name two different programs.
 */
export const PI_SESSION_PROGRAM = "pi-session";

export const PI_CHAT_WINDOW_REF: RendererRef = {
	kind: "host-native",
	ref: "tuval/pi-chat-window",
};
