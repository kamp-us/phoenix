/**
 * The session-list row's renderer reference, as a leaf both ends can import.
 *
 * Same split as `../pi/renderer-ref.ts` and `../claude/renderer-ref.ts`, for the same reason: the
 * row is kernel-side and reaches every backend's session store, the renderer is browser-side and
 * must reach none of it, so the one name they share lives alone in a file that imports one type.
 *
 * It sits here rather than inside `./window/`, because the strict lens must list every file it
 * compiles: `./window/` is excluded from it whole (it imports `@kampus/design`, which needs the
 * relaxed lens of `tsconfig.design.json`), and a file the row imports out of an excluded directory
 * is a `TS6307` on every build.
 */

import type {RendererRef} from "../registry/program.ts";

export const SESSION_LIST_WINDOW_REF: RendererRef = {
	kind: "host-native",
	ref: "tuval/session-list-window",
};
