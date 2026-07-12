/**
 * Regression proof for #2593 (the mecmua-reader hard-crash regression from #2584): a re-seed
 * `setContent` that fires against a torn-down tiptap editor must NOT throw
 * `Cannot read properties of null (reading 'commands')`. The re-seed effect routes setContent
 * through the handle, so the crash surfaces at that seam — pinned here, plus a check that the
 * effect keeps re-seeding across content changes (the happy path #2584 shipped).
 */
import {act, render, renderHook, waitFor} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {createComposerHandle} from "./handle.ts";
import {ReadOnlyComposer} from "./ReadOnlyComposer.tsx";
import {useComposerEditor} from "./useComposerEditor.ts";

async function surface(container: HTMLElement): Promise<HTMLElement> {
	let el: HTMLElement | null = null;
	await waitFor(() => {
		el = container.querySelector<HTMLElement>(".tiptap");
		expect(el).not.toBeNull();
	});
	if (!el) throw new Error("no render surface");
	return el;
}

describe("setContent readiness guard (#2593)", () => {
	it("handle.setContent is a no-op — no `reading 'commands'` throw — when the editor is destroyed", async () => {
		const {result} = renderHook(() => useComposerEditor({content: "ilk gövde"}));
		await waitFor(() => expect(result.current).not.toBeNull());
		const editor = result.current?.editor;
		if (!editor) throw new Error("editor did not mount");

		// The bad tick: a StrictMode double-invoke / remount tears the tiptap instance down while a
		// stale re-seed still holds a handle onto it (a fresh handle over the SAME torn-down editor
		// is that stale route made deterministic). @tiptap/core's destroy() nulls commandManager, so
		// the `editor.commands` getter throws `Cannot read properties of null (reading 'commands')`.
		act(() => editor.destroy());
		expect(editor.isDestroyed).toBe(true);
		const staleHandle = createComposerHandle(editor);

		// Before the fix, setContent read `editor.commands` unconditionally and threw right here —
		// the exact frame the mecmua reader unwound to its error boundary on.
		expect(() => staleHandle.setContent("yeni gövde")).not.toThrow();
	});

	it("the ReadOnlyComposer re-seed effect applies new content across renders (no happy-path regression)", async () => {
		const {container, rerender} = render(<ReadOnlyComposer content="## Birinci" />);
		const first = await surface(container);
		await waitFor(() => expect(first.querySelector("h2")?.textContent).toContain("Birinci"));

		// One mounted reader rendering a different post's body without a remount — the re-seed the
		// ReadOnlyComposer effect drives — must swap the content, not stall on the seed-at-creation.
		rerender(<ReadOnlyComposer content="## İkinci" />);
		const second = await surface(container);
		await waitFor(() => expect(second.querySelector("h2")?.textContent).toContain("İkinci"));
	});
});
