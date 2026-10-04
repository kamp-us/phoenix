/**
 * T1 (issue #2480 AC) — the `ComposerHandle` over a headless `Editor` built from `baseKit()` (the
 * same instance the hook wraps), with no render. The markdown round-trip and `toJSON()` through the
 * React render path are `renderTestMarkdown.render.test.tsx`'s; editor≈reader parity is
 * `ReadOnlyComposer.render.test.tsx`'s.
 */
import {Editor} from "@tiptap/core";
import {describe, expect, it} from "vitest";
import {createComposerHandle} from "./handle.ts";
import {baseKit} from "./index.ts";

describe("ComposerHandle I/O over baseKit()", () => {
	it("seeds empty and stays empty-safe", () => {
		const handle = createComposerHandle(new Editor(baseKit()));
		expect(handle.getMarkdown()).toBe("");
		expect(handle.toJSON()).toMatchObject({type: "doc"});
	});
});
