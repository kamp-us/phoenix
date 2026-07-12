/**
 * The reader-half render proof (#2581, resolving #2578's symptoms through the shared path):
 * markdown authored via the composer, then rendered through {@link ReadOnlyComposer}, renders
 * as rich read-only DOM — headings/links/lists/emphasis, with NONE of #2578's raw-markup leaks
 * (`## text`, escaped `\[ \]`, literal `&nbsp;`). It also pins editor≈reader parity (the editable
 * and read-only paths produce the same rendered markup) and XSS-safety (the baseKit ProseMirror
 * schema drops script/event-handler/js-url payloads).
 */
import {act, render, renderHook, waitFor} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Composer} from "./Composer.tsx";
import {ReadOnlyComposer} from "./ReadOnlyComposer.tsx";
import {useComposerEditor} from "./useComposerEditor.ts";

/** Author markdown through the editable composer and return `getMarkdown()` — the exact storage form. */
async function authorAndStore(input: string): Promise<string> {
	const {result} = renderHook(() => useComposerEditor());
	await waitFor(() => expect(result.current).not.toBeNull());
	const handle = result.current;
	if (!handle) throw new Error("editor did not mount");
	act(() => handle.setContent(input));
	return handle.getMarkdown();
}

/** The ProseMirror render surface for a mounted composer/reader — the `.tiptap` element. */
async function surface(container: HTMLElement): Promise<HTMLElement> {
	let el: HTMLElement | null = null;
	await waitFor(() => {
		el = container.querySelector<HTMLElement>(".tiptap");
		expect(el).not.toBeNull();
	});
	if (!el) throw new Error("no render surface");
	return el;
}

const SAMPLE = `## Başlık

Bir paragraf **kalın** ve *italik* içerir. [kamp.us](https://kamp.us) bağlantısı da var.

- birinci
- ikinci`;

describe("ReadOnlyComposer render path (#2581)", () => {
	it("renders composer-authored markdown as rich read-only DOM (no raw ## / \\[ \\] / &nbsp;)", async () => {
		// The real reader flow: author via composer → the stored markdown → render read-only.
		const stored = await authorAndStore(SAMPLE);
		const {container} = render(<ReadOnlyComposer content={stored} />);
		const el = await surface(container);

		// #2578's symptoms are gone — real elements, not literal markup.
		expect(el.querySelector("h2")?.textContent).toContain("Başlık");
		const anchor = el.querySelector("a");
		expect(anchor).not.toBeNull();
		expect(anchor?.getAttribute("href")).toBe("https://kamp.us");
		expect(el.querySelectorAll("li").length).toBe(2);
		expect(el.querySelector("strong")?.textContent).toBe("kalın");
		expect(el.querySelector("em")?.textContent).toBe("italik");

		// No raw markdown / escaping / entity leaks in the visible text (the #2578 bug).
		const text = el.textContent ?? "";
		expect(text).not.toContain("##");
		expect(text).not.toContain("\\[");
		expect(text).not.toContain("\\]");
		expect(text).not.toContain("&nbsp;");
	});

	it("is non-editable (no editing affordances on the reader surface)", async () => {
		const {container} = render(<ReadOnlyComposer content={SAMPLE} />);
		const el = await surface(container);
		expect(el.getAttribute("contenteditable")).toBe("false");
	});

	it("legacy escaped-link markdown renders without visible \\[ \\] backslashes and links live", async () => {
		// The exact #2578 stored form — the shared path consumes the backslash escaping (no leak)
		// and the URL renders as a live anchor.
		const {container} = render(
			<ReadOnlyComposer content={"\\[naber\\](https://phoenix.kamp.us)"} />,
		);
		const el = await surface(container);
		const text = el.textContent ?? "";
		expect(text).not.toContain("\\[");
		expect(text).not.toContain("\\]");
		expect(el.querySelector('a[href="https://phoenix.kamp.us"]')).not.toBeNull();
	});

	it("editor≈reader parity: editable and read-only render the same markup", async () => {
		const stored = await authorAndStore(SAMPLE);
		const rw = render(<AuthoredEditor content={stored} />);
		const ro = render(<ReadOnlyComposer content={stored} />);
		const rwEl = await surface(rw.container);
		const roEl = await surface(ro.container);
		// The rendered node markup is identical (the reader is the editor, editing off) — the two
		// halves share one path, so the only difference is the contenteditable flag itself.
		expect(roEl.getAttribute("contenteditable")).toBe("false");
		expect(rwEl.getAttribute("contenteditable")).toBe("true");
		expect(roEl.innerHTML).toBe(rwEl.innerHTML);
	});

	it("XSS-safe: script / onerror / javascript: payloads are neutralized by the schema", async () => {
		const payload = [
			"<script>window.__pwned = 1</script>",
			'<img src=x onerror="window.__pwned = 1">',
			"[tık](javascript:window.__pwned=1)",
		].join("\n\n");
		const {container} = render(<ReadOnlyComposer content={payload} />);
		const el = await surface(container);

		// No script node, no surviving event-handler attribute, no javascript: href.
		expect(container.querySelectorAll("script").length).toBe(0);
		expect(el.querySelector("[onerror]")).toBeNull();
		for (const a of el.querySelectorAll("a")) {
			expect(a.getAttribute("href") ?? "").not.toContain("javascript:");
		}
	});
});

/** An editable composer seeded with markdown — the parity baseline for the read-only surface. */
function AuthoredEditor({content}: {content: string}) {
	const composer = useComposerEditor({content});
	return <Composer composer={composer} />;
}
