/**
 * T1 (issue #2480 AC) — pins the v1 public-surface contract: the `index.ts` exports a
 * consumer needs are all present, and the markdown round-trip + `toJSON()` are reachable
 * through the `ComposerHandle` that `useComposerEditor` returns. The handle is exercised
 * over a headless `Editor` built from `baseKit()` (the same instance the hook wraps), so
 * this stays a no-render unit test — the React render-path fixture lands separately (#2482).
 */
import {Editor} from "@tiptap/core";
import {beforeEach, describe, expect, it} from "vitest";
import {type ComposerHandle, createComposerHandle} from "./handle.ts";
import * as composer from "./index.ts";
import {baseKit} from "./index.ts";

const SAMPLE = `# Başlık

Bir paragraf **kalın**, *italik* ve \`kod\` içerir.

- birinci
- ikinci

> alıntı`;

describe("public export surface", () => {
	it("exposes exactly the v1 contract as named exports", () => {
		expect(typeof composer.useComposerEditor).toBe("function");
		expect(typeof composer.Composer).toBe("function");
		expect(typeof composer.baseKit).toBe("function");
		// The read-only render mode (#2581) is part of the public surface — a consumer (mecmua
		// reader) renders through it without importing tiptap or reaching a deep path.
		expect(typeof composer.ReadOnlyComposer).toBe("function");
		// No deep-path import is required of a consumer: everything above resolves from the root.
	});
});

describe("read-only render mode over baseKit() (#2581)", () => {
	// The reader is the editor with editing switched off: the SAME baseKit path, `editable:false`.
	// This no-render unit pins that the mode is non-editable and serializes the stored markdown
	// identically to the editable path — the render-path DOM assertions live in the .render test.
	it("an editable:false editor is non-editable yet round-trips the same markdown", () => {
		const ro = createComposerHandle(new Editor({...baseKit(), editable: false}));
		const rw = createComposerHandle(new Editor(baseKit()));
		expect(ro.editor.isEditable).toBe(false);
		expect(rw.editor.isEditable).toBe(true);

		ro.setContent(SAMPLE);
		rw.setContent(SAMPLE);
		// Editor≈reader parity at the serialization layer: the same input yields identical
		// markdown regardless of editability — one render path, no divergence.
		expect(ro.getMarkdown()).toBe(rw.getMarkdown());
		expect(ro.getMarkdown()).toContain("# Başlık");
	});
});

describe("ComposerHandle I/O over baseKit()", () => {
	let handle: ComposerHandle;

	beforeEach(() => {
		handle = createComposerHandle(new Editor(baseKit()));
	});

	it("round-trips markdown: setContent → getMarkdown returns the equivalent markdown", () => {
		handle.setContent(SAMPLE);
		const out = handle.getMarkdown();
		expect(out).toContain("# Başlık");
		expect(out).toContain("**kalın**");
		expect(out).toContain("*italik*");
		expect(out).toContain("`kod`");
		expect(out).toContain("> alıntı");

		// Idempotent: re-seeding the serialized output yields byte-identical markdown,
		// which is the load-bearing round-trip property (equivalent in, equivalent out).
		handle.setContent(out);
		expect(handle.getMarkdown()).toBe(out);
	});

	it("exposes reachable JSON via toJSON() as a ProseMirror doc", () => {
		handle.setContent(SAMPLE);
		const json = handle.toJSON();
		expect(json).toMatchObject({type: "doc"});
		expect(Array.isArray(json.content)).toBe(true);
	});

	it("seeds empty and stays empty-safe", () => {
		expect(handle.getMarkdown()).toBe("");
		expect(handle.toJSON()).toMatchObject({type: "doc"});
	});
});
