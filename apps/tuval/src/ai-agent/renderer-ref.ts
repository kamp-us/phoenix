/**
 * The session-list row's renderer reference and the predicate over its state, as a leaf both ends
 * can import.
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

/**
 * The desk inspector every ai-agent backend declares (#8190). One reference, not one per backend:
 * what it shows is read off `AiAgentSessionState`, which is the state both rows already run, so a
 * second name would be two tables answering the same walk with the same panel.
 */
export const AI_AGENT_INSPECTOR_REF: RendererRef = {
	kind: "host-native",
	ref: "tuval/ai-agent-inspector",
};

/**
 * The row holds nothing worth the name — its surface renders a list it asks for by spell
 * (`./session-list.ts`) — but it still carries its own tag, because a page admits a renderer only
 * over a state some predicate recognised (`.patterns/window-renderer-admission.md`). A bare `{}`
 * is recognisable as nothing, so a stateless row would be admitted over any other program's state.
 */
export interface SessionListState {
	readonly kind: "ai-agent-sessions";
}

export const SESSION_LIST_STATE: SessionListState = {kind: "ai-agent-sessions"};

export const isSessionListState = (value: unknown): value is SessionListState =>
	typeof value === "object" &&
	value !== null &&
	(value as {readonly kind?: unknown}).kind === "ai-agent-sessions";
