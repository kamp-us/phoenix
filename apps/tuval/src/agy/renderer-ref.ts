/**
 * The `agy-session` row's two names — its program id and its renderer reference — as a leaf both
 * ends can import.
 *
 * Same split as `../pi/renderer-ref.ts`, for the same reason: the row is kernel-side and drives the
 * `agy` CLI over a subprocess, the renderer is browser-side and must reach none of that, so the two
 * names they share live alone in a file that imports one type.
 *
 * It sits beside the row rather than inside `./window/`, because the strict lens is `composite` and
 * must list every file it compiles: `./window/` is excluded from it whole (it imports
 * `@kampus/design`, which needs the relaxed lens of `tsconfig.design.json`), and a file the row
 * imports out of an excluded directory is a `TS6307` on every build.
 */

import type {RendererRef} from "../registry/program.ts";

/**
 * The row's program id. It is declared here rather than on the row for the reason `../pi`'s twin
 * documents: importing it from the row would pull the agy subprocess and the whole kernel-side row
 * into the browser bundle, which is the failure #7836 closed. The row re-exports it, so there is
 * one declaration and nothing can name two different programs.
 */
export const AGY_SESSION_PROGRAM = "agy-session";

export const AGY_CHAT_WINDOW_REF: RendererRef = {
	kind: "host-native",
	ref: "tuval/agy-chat-window",
};
