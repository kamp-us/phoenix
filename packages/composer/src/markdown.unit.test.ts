/**
 * T1 (issue #2479 AC) — the base's markdown round-trip contract, tested against a
 * headless `Editor` built from `baseKit()`: seed markdown in, `getMarkdown()` echoes
 * the equivalent markdown, and `getJSON()` is reachable. This is the seam the
 * `/lab/composer` inline `useEditor(...)` collapses into.
 */
import {Editor} from "@tiptap/core";
import {beforeEach, describe, expect, it} from "vitest";
import {baseKit} from "./baseKit.ts";
import {getJSON, getMarkdown, setMarkdown} from "./markdown.ts";

const SAMPLE = `# Başlık

Bir paragraf **kalın**, *italik* ve \`kod\` içerir.

- birinci
- ikinci

> alıntı`;

describe("markdown I/O over baseKit()", () => {
	let editor: Editor;

	beforeEach(() => {
		editor = new Editor(baseKit());
	});

	it("round-trips markdown: seed → getMarkdown() returns the equivalent markdown", () => {
		setMarkdown(editor, SAMPLE);
		const out = getMarkdown(editor);
		// Structure survives the parse → serialize round-trip.
		expect(out).toContain("# Başlık");
		expect(out).toContain("**kalın**");
		expect(out).toContain("*italik*");
		expect(out).toContain("`kod`");
		expect(out).toContain("> alıntı");

		// Idempotent: re-seeding the serialized output yields byte-identical markdown,
		// which is the load-bearing round-trip property (equivalent in, equivalent out).
		setMarkdown(editor, out);
		expect(getMarkdown(editor)).toBe(out);
	});

	it("exposes reachable JSON (toJSON) as a ProseMirror doc", () => {
		setMarkdown(editor, SAMPLE);
		const json = getJSON(editor);
		expect(json).toMatchObject({type: "doc"});
		expect(Array.isArray(json.content)).toBe(true);
	});

	it("seeds empty and stays empty-safe", () => {
		expect(getMarkdown(editor)).toBe("");
		expect(getJSON(editor)).toMatchObject({type: "doc"});
	});
});
