/**
 * T1 (issue #2482 AC) — the canonical render / round-trip checklist over the base. Unlike
 * the no-render handle test (`public-surface.unit.test.ts`, #2480), this drives the fixture
 * through the React render path — `useComposerEditor` via `renderHook` — so it exercises the
 * same wiring `/lab/composer` and every product consumer use, not a bare `new Editor(...)`.
 *
 * Two properties are pinned: the markdown round-trips (`setContent(renderTestMarkdown)` →
 * `getMarkdown()` is idempotent, the load-bearing "equivalent in, equivalent out"), and every
 * block node type the fixture claims to cover actually appears in `toJSON()` — a real render
 * checklist that would catch a regression in the base before mecmua/sözlük/pano depend on it.
 */
import {act, renderHook, waitFor} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import type {ComposerJSON} from "./handle.ts";
import {renderTestMarkdown} from "./renderTestMarkdown.ts";
import {useComposerEditor} from "./useComposerEditor.ts";

/** Every node `type` in the ProseMirror doc, walked depth-first — the checklist's evidence. */
function collectNodeTypes(node: ComposerJSON, acc: Set<string> = new Set()): Set<string> {
	if (node.type) acc.add(node.type);
	for (const child of node.content ?? []) collectNodeTypes(child, acc);
	return acc;
}

// The block nodes baseKit() (StarterKit + @tiptap/markdown) round-trips and the fixture
// exercises. Task-list / table are intentionally absent from both fixture and this list —
// the v1 set ships no such node (see renderTestMarkdown's drop note).
const EXPECTED_BLOCK_NODES = [
	"heading",
	"paragraph",
	"bulletList",
	"orderedList",
	"listItem",
	"blockquote",
	"codeBlock",
	"horizontalRule",
];

describe("renderTestMarkdown through useComposerEditor (render path)", () => {
	it("round-trips the fixture: setContent → getMarkdown is idempotent and preserves every element", async () => {
		const {result} = renderHook(() => useComposerEditor());
		await waitFor(() => expect(result.current).not.toBeNull());
		const handle = result.current;
		if (!handle) throw new Error("editor did not mount");

		act(() => handle.setContent(renderTestMarkdown));
		const out = handle.getMarkdown();

		expect(out).toContain("# Composer render testi");
		expect(out).toContain("###### Altıncı seviye başlık");
		expect(out).toContain("**kalın**");
		expect(out).toContain("*italik*");
		expect(out).toContain("~~üstü çizili~~");
		expect(out).toContain("`satır içi kod`");
		expect(out).toContain("[kamp.us bağlantısı](https://kamp.us)");
		expect(out).toContain("- birinci madde");
		expect(out).toContain("1. birinci adım");
		expect(out).toContain("> Bir alıntı bloğu");
		expect(out).toContain("```ts");
		expect(out).toContain("---");

		// The load-bearing property: re-seeding the serialized output yields byte-identical
		// markdown (equivalent in → equivalent out). tiptap's serializer may normalize the
		// first pass, so idempotency — not equality to the raw input — is what round-trip means.
		act(() => handle.setContent(out));
		expect(handle.getMarkdown()).toBe(out);
	});

	it("renders every expected block node type into toJSON()", async () => {
		const {result} = renderHook(() => useComposerEditor({content: renderTestMarkdown}));
		await waitFor(() => expect(result.current).not.toBeNull());
		const handle = result.current;
		if (!handle) throw new Error("editor did not mount");

		const json = handle.toJSON();
		expect(json).toMatchObject({type: "doc"});
		const nodeTypes = collectNodeTypes(json);
		for (const type of EXPECTED_BLOCK_NODES) {
			expect(nodeTypes).toContain(type);
		}
	});
});
