/**
 * The `agy-session` row's two names — its program id and its renderer reference — as a leaf both
 * ends can import.
 *
 * Same split as `@kampus/tuval-pi`'s `src/renderer-ref.ts`, for the same reason: the row is kernel-side and drives the
 * `agy` CLI over a subprocess, the renderer is browser-side and must reach none of that, so the two
 * names they share live alone in a file that imports one type.
 *
 * It sits beside the row rather than inside `./window/`, because the package's root entry re-exports
 * it and that entry must reach no React: a leaf inside `./window/` would sit one wrong import away
 * from pulling the window into every config module.
 */

import type {RendererRef} from "@kampus/tuval-sdk/kernel/registry/program";

/**
 * The row's program id. It is declared here rather than on the row for the reason Pi's twin
 * documents: importing it from the row would pull the agy subprocess and the whole kernel-side row
 * into the browser bundle, which is the failure #7836 closed. The row re-exports it, so there is
 * one declaration and nothing can name two different programs.
 */
export const AGY_SESSION_PROGRAM = "agy-session";

export const AGY_CHAT_WINDOW_REF: RendererRef = {
	kind: "host-native",
	ref: "tuval/agy-chat-window",
};
