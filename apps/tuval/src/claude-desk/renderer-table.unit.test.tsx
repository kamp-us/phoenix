/**
 * @vitest-environment jsdom
 *
 * The Claude row's renderer reference against the page's renderer table. The table is the desk's,
 * so this case lives here; the window itself is proven in `@kampus/tuval-claude`.
 */

import {claudeSessionState} from "@kampus/tuval-claude/testing/window";
import {CLAUDE_CHAT_WINDOW_REF, ClaudeChatWindow} from "@kampus/tuval-claude/window";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {pageRenderers} from "../page/renderers.tsx";

/** The table over a socket that answers nothing: this file judges the Claude entry, never a call. */
const renderers = pageRenderers(
	() => Effect.never,
	() => undefined,
);

describe("the row's renderer reference", () => {
	// Not an identity check against `ClaudeChatWindow` any more: the page builds its own renderer at
	// the operator's feature flags, so the table holds an equivalent renderer rather than this
	// module's default constant (#8439). What is still checked is that the reference has a seat, that
	// the seat holds a renderer of the kind the reference declares, and its guard.
	it("resolves to a renderer of this kind in the page's table", () => {
		const entry = renderers[CLAUDE_CHAT_WINDOW_REF.ref];
		expect(entry?.renderer.kind).toBe(CLAUDE_CHAT_WINDOW_REF.kind);
		expect(entry?.renderer.kind).toBe(ClaudeChatWindow.kind);
		// Guarded by the session state's own predicate, so a kernel sending an older shape refuses in
		// this window instead of throwing through it (#8157).
		expect(entry?.admits(claudeSessionState())).toBe(true);
		expect(entry?.admits({phase: "idle"})).toBe(false);
	});
});
